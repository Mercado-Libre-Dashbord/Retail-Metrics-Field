import { Pool, type PoolClient } from "pg";
import { BUSINESS_TIME_ZONE } from "@/lib/dates";

let pool: Pool | null = null;

function getPool(): Pool {
  if (!pool) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
  }
  return pool;
}

/** Minimal shape both `Pool` and `PoolClient` satisfy — lets db/*.ts helpers
 * accept either without depending on pg's exact types. */
export interface QueryExecutor {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface ScopeContext {
  /** Which account's rows RLS policies should allow. Omit for admin-only
   * lookups against the `accounts` table itself (e.g. listing all accounts). */
  accountId?: string | null;
  isAdmin?: boolean;
  userEmail?: string | null;
  /** Hash de la credencial de fidelización, para el caso sin sesión de
   * usuario: la app de la billetera se identifica con una clave por cuenta.
   * Ver la política `accounts_select` en db/postgres/schema.sql. */
  loyaltyKeyHash?: string | null;
  /** Email candidato durante un intento de login por contraseña, ANTES de
   * verificar que la contraseña es correcta. Deja ver esa única fila de
   * credential_users — no implica que el login haya sido exitoso. */
  credentialLookupEmail?: string | null;
  /** Hash del token de una invitación de login por contraseña, para poder
   * consultarla/consumirla sin tener todavía una sesión. */
  credentialInviteHash?: string | null;
}

/**
 * Runs `fn` inside a transaction with the app.* session variables set via
 * `SET LOCAL` (through `set_config(..., true)`), so every RLS policy in
 * db/postgres/schema.sql sees the right account/admin/email for this
 * request only. Always BEGIN/COMMIT (or ROLLBACK) — `SET LOCAL` outside an
 * explicit transaction is a no-op on the next statement, and a pooled
 * connection could otherwise leak scope into the next request that reuses it.
 */
export async function withScope<T>(ctx: ScopeContext, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // Los días y meses de todos los reportes (`::date`, `to_char`) se cortan
    // en hora del negocio, no en UTC: ver lib/dates.ts.
    await client.query("SELECT set_config('TimeZone', $1, true)", [BUSINESS_TIME_ZONE]);
    await client.query("SELECT set_config('app.current_account_id', $1, true)", [ctx.accountId ?? ""]);
    await client.query("SELECT set_config('app.is_admin', $1, true)", [ctx.isAdmin ? "true" : "false"]);
    await client.query("SELECT set_config('app.current_user_email', $1, true)", [ctx.userEmail ?? ""]);
    await client.query("SELECT set_config('app.loyalty_key_hash', $1, true)", [ctx.loyaltyKeyHash ?? ""]);
    await client.query("SELECT set_config('app.credential_lookup_email', $1, true)", [ctx.credentialLookupEmail ?? ""]);
    await client.query("SELECT set_config('app.credential_invite_hash', $1, true)", [ctx.credentialInviteHash ?? ""]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// For testing purposes - close and reset the pool.
export async function closeDb(): Promise<void> {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end();
  }
}
