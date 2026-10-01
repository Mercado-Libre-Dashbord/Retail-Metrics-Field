import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { resolveCurrentAccount } from "@/lib/current-account";
import { ML_OAUTH_STATE_COOKIE } from "@/lib/ml-oauth";

export const runtime = "nodejs";

export async function GET() {
  const account = await resolveCurrentAccount();
  if (!account) {
    return NextResponse.json({ error: "No hay una cuenta activa para conectar" }, { status: 400 });
  }

  // El `state` es un valor aleatorio de un solo uso, guardado también en una
  // cookie httpOnly de este navegador. Antes era el id de la cuenta: un valor
  // predecible con el que un tercero podía armar un link para que la cuenta
  // de otra persona quedara vinculada a SU cuenta de Mercado Libre (CSRF en
  // la vinculación). Ahora el callback solo acepta el state que este mismo
  // navegador pidió, para esta misma cuenta.
  const nonce = randomBytes(24).toString("base64url");
  const state = `${account.id}.${nonce}`;
  const params = new URLSearchParams({
    response_type: "code",
    client_id: process.env.ML_CLIENT_ID!,
    redirect_uri: process.env.ML_REDIRECT_URI!,
    state,
  });
  const response = NextResponse.redirect(`https://auth.mercadolibre.com.ar/authorization?${params.toString()}`);
  response.cookies.set(ML_OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/api/ml",
    maxAge: 10 * 60,
  });
  return response;
}
