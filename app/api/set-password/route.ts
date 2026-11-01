import { NextRequest, NextResponse } from "next/server";
import { withScope } from "@/db/client";
import { getInviteByTokenHash, setCredentialPassword, markInviteUsed } from "@/db/credentials";
import { hashPassword, hashInviteToken, isValidInviteToken, MIN_PASSWORD_LENGTH } from "@/lib/credentials-auth";

export const runtime = "nodejs";

/**
 * Sin sesión a propósito: quien llega acá todavía no puede loguearse, es
 * justo lo que está por resolver. La única llave es el token de la
 * invitación que le mandó el admin — ver migración 016 para cómo RLS deja
 * escribir credential_users solo si ese token es válido para ese email.
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const { token, password } = body as { token?: string; password?: string };

  if (!token || typeof token !== "string" || !isValidInviteToken(token)) {
    return NextResponse.json({ error: "El link de invitación no es válido." }, { status: 400 });
  }
  if (!password || typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    return NextResponse.json({ error: `La contraseña tiene que tener al menos ${MIN_PASSWORD_LENGTH} caracteres.` }, { status: 400 });
  }

  const tokenHash = hashInviteToken(token);

  const result = await withScope({ credentialInviteHash: tokenHash }, async (client) => {
    const invite = await getInviteByTokenHash(client, tokenHash);
    if (!invite) return { error: "El link de invitación no existe o ya no es válido." as const };
    if (invite.usedAt) return { error: "Este link ya se usó. Pedí uno nuevo desde '¿Olvidaste tu contraseña?' o pedíselo a tu administrador." as const };
    if (new Date(invite.expiresAt) <= new Date()) return { error: "Este link venció. Pedí uno nuevo desde '¿Olvidaste tu contraseña?' o pedíselo a tu administrador." as const };

    const passwordHash = await hashPassword(password);
    const saved = await setCredentialPassword(client, invite.email, passwordHash);
    if (!saved) return { error: "No se pudo guardar la contraseña. Pedile a tu administrador un link nuevo." as const };

    await markInviteUsed(client, tokenHash);
    return { email: invite.email };
  });

  if ("error" in result) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json({ ok: true, email: result.email });
}
