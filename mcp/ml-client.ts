const ML_API_BASE = "https://api.mercadolibre.com";

export class MlApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/**
 * Un solo reintento no alcanzaba: en una cuenta grande, ML puede seguir
 * devolviendo 429 más de una vez seguida bajo carga real (visto en
 * producción en /orders/search). Con backoff creciente da más margen para
 * que el límite se libere solo, sin gastar todo el presupuesto de 60s de la
 * función en un único llamado.
 */
const MAX_429_RETRIES = 3;

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
  if (res.status === 429 && retryCount < MAX_429_RETRIES) {
    const retryAfterHeader = (res as any).headers?.get?.("Retry-After");
    const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : NaN;
    const backoffMs = Math.min(1000 * 2 ** retryCount, 4000);
    const waitMs = Number.isFinite(retryAfterMs) ? Math.min(retryAfterMs, 5000) : backoffMs;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    return mlFetch(path, accessToken, init, retryCount + 1);
  }
  if (res.status === 429) {
    // Se agotaron los reintentos: el mensaje técnico de ML ("local_rate_limited")
    // queda en el mensaje para los logs, pero quien llama (la ruta de sync)
    // decide qué mostrarle al vendedor a partir del status 429.
    throw new MlApiError(429, `ML API error 429 on ${path}: ${await extractMlErrorMessage(res)}`);
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
