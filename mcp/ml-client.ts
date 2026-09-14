const ML_API_BASE = "https://api.mercadolibre.com";

export class MlApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function mlFetch(
  path: string,
  accessToken: string,
  init: RequestInit = {},
  retryCount = 0
): Promise<any> {
  const res = await fetch(`${ML_API_BASE}${path}`, {
    ...init,
    headers: { ...(init.headers || {}), Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 429 && retryCount < 1) {
    const retryAfterHeader = (res as any).headers?.get?.("Retry-After");
    const waitMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : 1000;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    return mlFetch(path, accessToken, init, retryCount + 1);
  }
  if (!res.ok) {
    throw new MlApiError(res.status, `ML API error ${res.status} on ${path}: ${await extractMlErrorMessage(res)}`);
  }
  return res.json();
}

/**
 * El body de error de ML es JSON con forma variable (`message`, `error`, y a
 * veces un array `cause` con un motivo por cada validación que falló) — sin
 * esto, ese JSON entero (llaves, corchetes, comillas y todo) terminaba
 * mostrado tal cual en pantalla como si fuera el mensaje de error, ilegible
 * para el vendedor. Si no se puede parsear (no es JSON, o no tiene ninguno
 * de esos campos), se usa el texto crudo como venía, acotado por las dudas.
 */
async function extractMlErrorMessage(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const body = JSON.parse(text);
    const causeMessages = Array.isArray(body?.cause)
      ? body.cause.map((c: unknown) => (c as { message?: string })?.message).filter(Boolean)
      : [];
    const message = [body?.message, ...causeMessages].filter(Boolean).join(" — ");
    if (message) return message;
  } catch {
    // No era JSON: se sigue con el texto tal cual, abajo.
  }
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

export async function refreshAccessToken(
  refreshToken: string
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const res = await fetch(`${ML_API_BASE}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: process.env.ML_CLIENT_ID!,
      client_secret: process.env.ML_CLIENT_SECRET!,
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) {
    throw new MlApiError(res.status, `Token refresh failed: ${await res.text()}`);
  }
  const data = await res.json();
  return { accessToken: data.access_token, refreshToken: data.refresh_token, expiresIn: data.expires_in };
}
