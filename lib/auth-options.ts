import type { NextAuthOptions } from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import CredentialsProvider from "next-auth/providers/credentials";
import { withScope } from "@/db/client";
import { getCredentialUserByEmail, recordFailedLogin, recordSuccessfulLogin } from "@/db/credentials";
import { verifyPassword } from "@/lib/credentials-auth";

/**
 * Admins: los mails de ADMIN_EMAILS más los de ADMIN_EMAILS_EXTRA. La segunda
 * existe porque en Vercel ADMIN_EMAILS es una variable "sensible" que no se
 * puede leer: para sumar un admin sin pisar la lista (y sin conocerla) se
 * agrega acá.
 */
export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const admins = `${process.env.ADMIN_EMAILS || ""},${process.env.ADMIN_EMAILS_EXTRA || ""}`
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return admins.includes(email.toLowerCase());
}

/**
 * Separada de la config de NextAuth para poder testearla directamente: el
 * objeto que devuelve `CredentialsProvider(...)` guarda esta función bajo
 * `.options.authorize`, no en `.authorize` de primer nivel (ese queda un
 * stub fijo que siempre da `null`) — importarla desde acá evita depender de
 * ese detalle interno para poder probarla.
 */
export async function authorizeCredentials(
  credentials: Record<"email" | "password", string> | undefined
): Promise<{ id: string; email: string } | null> {
  const email = credentials?.email?.trim().toLowerCase();
  const password = credentials?.password;
  if (!email || !password) return null;

  try {
    const user = await withScope({ credentialLookupEmail: email }, (client) =>
      getCredentialUserByEmail(client, email)
    );
    if (!user) return null;

    // Bloqueada por intentos fallidos recientes: ni se compara la
    // contraseña — evita malgastar el costo de scrypt y, sobre todo, corta
    // la fuerza bruta mientras dure el bloqueo.
    if (user.lockedUntil && new Date(user.lockedUntil) > new Date()) return null;

    const valid = await verifyPassword(password, user.passwordHash);
    await withScope({ credentialLookupEmail: email }, (client) =>
      valid ? recordSuccessfulLogin(client, email) : recordFailedLogin(client, email)
    );
    if (!valid) return null;

    return { id: email, email };
  } catch {
    // Tabla todavía no migrada (016) o cualquier falla de infra: se trata
    // como login inválido, no como un 500 que tire la pantalla de login
    // entera — Google sigue funcionando igual mientras tanto.
    return null;
  }
}

export const authOptions: NextAuthOptions = {
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID || "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
    }),
    // Para clientes sin cuenta de Google (ej. Hotmail/Outlook): login con
    // email y contraseña, dada de alta por un admin vía invitación de un
    // solo uso (ver migración 016 y /api/admin/credential-invites). No es
    // un registro abierto — nadie elige su email acá, solo pone la
    // contraseña que le corresponde a un email ya invitado.
    CredentialsProvider({
      name: "Email y contraseña",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Contraseña", type: "password" },
      },
      authorize: authorizeCredentials,
    }),
  ],
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  callbacks: {
    async jwt({ token }) {
      token.isAdmin = isAdminEmail(token.email);
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.isAdmin = token.isAdmin === true;
      }
      return session;
    },
  },
};
