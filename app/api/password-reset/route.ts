import { NextRequest, NextResponse } from "next/server";
import { withScope } from "@/db/client";
import { generateInviteToken, hashInviteToken, MAX_RESETS_PER_HOUR, RESET_EXPIRY_MINUTES } from "@/lib/credentials-auth";
import { mailEnabled, sendMail } from "@/lib/mailer";
import { passwordResetMail } from "@/lib/password-reset-mail";

export const runtime = "nodejs";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Siempre la misma respuesta: no decir si un email tiene cuenta o no. */
const SENT = { ok: true, message: "Si ese email tiene acceso, te mandamos un link para elegir una contraseña nueva. Revisá también la carpeta de spam." };

function appUrl(request: NextRequest): string {
  return (process.env.NEXTAUTH_URL || request.nextUrl.origin).replace(/\/+$/, "");
}

/**
 * "Olvidé mi contraseña" / "Cambiar contraseña": manda al email un link de un
 * solo uso para elegir una contraseña nueva (la misma página que usa la
 * invitación del admin). Sin sesión a propósito. La función de la migración
 * 026 decide si corresponde (el email tiene acceso, no se pasó del límite
 * por hora) sin dejar ver nada de la base.
 */
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as { email?: unknown };
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!EMAIL_RE.test(email) || email.length > 254) {
    return NextResponse.json({ error: "Escribí un email válido." }, { status: 400 });
  }
  if (!mailEnabled()) {
    return NextResponse.json(
      { error: "El envío de mails todavía no está configurado. Pedile a tu administrador un link para cambiar la contraseña." },
      { status: 503 }
    );
  }

  const token = generateInviteToken();
  const created = await withScope({}, async (client) => {
    const r = await client.query<{ ok: boolean }>(`SELECT credential_request_reset($1, $2, $3, $4) as ok`, [
      email,
      hashInviteToken(token),
      RESET_EXPIRY_MINUTES,
      MAX_RESETS_PER_HOUR,
    ]);
    return r.rows[0]?.ok === true;
  }).catch((err) => {
    // Sin la migración 026 la función no existe: mejor decirlo que fallar en silencio.
    if ((err as { code?: string }).code === "42883") return null;
    throw err;
  });
  if (created === null) {
    return NextResponse.json({ error: "Falta correr la migración db/postgres/migrations/026-recuperar-contrasena.sql." }, { status: 503 });
  }

  if (created) {
    const link = `${appUrl(request)}/set-password?token=${encodeURIComponent(token)}&reset=1`;
    try {
      await sendMail(passwordResetMail(email, link));
    } catch (err) {
      console.error("[password-reset] no se pudo mandar el mail:", (err as Error).message);
      return NextResponse.json({ error: "No pudimos mandar el mail. Probá de nuevo en unos minutos." }, { status: 502 });
    }
  }
  return NextResponse.json(SENT);
}
