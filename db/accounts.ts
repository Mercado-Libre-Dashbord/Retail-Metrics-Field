import { nanoid } from "nanoid";
import type { QueryExecutor } from "./client";
import { hasColumn } from "./schema-capabilities";

export type TaxCondition = "responsable_inscripto" | "monotributo" | "exento";

export interface Account {
  id: string;
  name: string;
  ownerEmail: string;
  mlSellerId: string | null;
  /** Otros impuestos (IIBB, internos) como fracción de la facturación: 0.03 = 3%. */
  otherTaxRate: number;
  /**
   * Régimen fiscal del vendedor. Decide si corresponde calcular IVA: el
   * precio de Mercado Libre solo "incluye" IVA para un Responsable Inscripto.
   * Default 'responsable_inscripto' porque es el caso de la enorme mayoría de
   * los vendedores de la plataforma.
   */
  taxCondition: TaxCondition;
  /** Si el vendedor ya eligió su régimen o todavía corre con el default sin
   * que se lo hayamos preguntado (ver migración 012). */
  taxConditionConfirmed: boolean;
  createdAt: string;
  /**
   * Hasta qué fecha ya se recorrió el historial completo de órdenes (ver
   * migración 018). `null`/`undefined` si la cuenta todavía no completó un
   * sync entero: el próximo sync arranca del historial completo, como
   * siempre. Opcional (no requerido en el tipo) para no obligar a todos los
   * mocks de test existentes a conocer este campo.
   */
  ordersSyncedThrough?: string | null;
}

/** Si corresponde calcular IVA para este régimen. Solo el Responsable
 * Inscripto discrimina IVA en el precio; Monotributo y exento, no. */
export function appliesIva(taxCondition: TaxCondition): boolean {
  return taxCondition === "responsable_inscripto";
}

interface AccountRow {
  id: string;
  name: string;
  owner_email: string;
  ml_seller_id: string | null;
  other_tax_rate?: number | string | null;
  tax_condition?: string | null;
  tax_condition_confirmed?: boolean | null;
  orders_synced_through?: string | Date | null;
  created_at: string | Date;
}

function mapRow(row: AccountRow): Account {
  return {
    id: row.id,
    name: row.name,
    ownerEmail: row.owner_email,
    mlSellerId: row.ml_seller_id,
    // La columna llega por migración; sin ella la cuenta simplemente no
    // tiene otros impuestos configurados todavía.
    otherTaxRate: Number(row.other_tax_rate ?? 0),
    // La columna llega por migración (011); sin ella, todas las cuentas se
    // siguen tratando como Responsable Inscripto — el comportamiento de
    // siempre, no un cambio de golpe.
    taxCondition: (row.tax_condition as TaxCondition | null) ?? "responsable_inscripto",
    // La columna llega por migración (012); sin ella no hay forma de
    // preguntar, así que se asume confirmada para no bloquear a nadie.
    taxConditionConfirmed: row.tax_condition_confirmed ?? true,
    createdAt: new Date(row.created_at).toISOString(),
    // La columna llega por migración (018); sin ella, ningún sync tiene de
    // dónde sacar un atajo y arranca del historial completo, como siempre.
    ordersSyncedThrough: row.orders_synced_through ? new Date(row.orders_synced_through).toISOString().slice(0, 10) : null,
  };
}

export async function createAccount(db: QueryExecutor, name: string, ownerEmail: string): Promise<Account> {
  const id = nanoid(12);
  const createdAt = new Date().toISOString();
  const normalizedEmail = ownerEmail.trim().toLowerCase();
  await db.query(
    `INSERT INTO accounts (id, name, owner_email, ml_seller_id, created_at) VALUES ($1, $2, $3, NULL, $4)`,
    [id, name, normalizedEmail, createdAt]
  );
  return {
    id, name, ownerEmail: normalizedEmail, mlSellerId: null,
    otherTaxRate: 0, taxCondition: "responsable_inscripto", taxConditionConfirmed: false, createdAt,
    ordersSyncedThrough: null,
  };
}

export async function listAccounts(db: QueryExecutor): Promise<Account[]> {
  const result = await db.query<AccountRow>("SELECT * FROM accounts ORDER BY created_at ASC");
  return result.rows.map(mapRow);
}

export async function getAccountById(db: QueryExecutor, id: string): Promise<Account | null> {
  const result = await db.query<AccountRow>("SELECT * FROM accounts WHERE id = $1", [id]);
  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

/** Edita nombre y/o email del dueño. Ninguno de los dos es obligatorio para
 * poder cambiar solo el otro. */
export async function updateAccountDetails(
  db: QueryExecutor,
  id: string,
  fields: { name?: string; ownerEmail?: string }
): Promise<Account | null> {
  const sets: string[] = [];
  const args: unknown[] = [];
  if (fields.name !== undefined) {
    args.push(fields.name);
    sets.push(`name = $${args.length}`);
  }
  if (fields.ownerEmail !== undefined) {
    args.push(fields.ownerEmail.trim().toLowerCase());
    sets.push(`owner_email = $${args.length}`);
  }
  if (sets.length === 0) return getAccountById(db, id);

  args.push(id);
  const result = await db.query<AccountRow>(
    `UPDATE accounts SET ${sets.join(", ")} WHERE id = $${args.length} RETURNING *`,
    args
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

/**
 * Borra una cuenta. Devuelve false si RLS no dejó (no admin), o si la
 * cuenta no existe. Las foreign keys de todas las tablas de datos (sin
 * ON DELETE CASCADE) rechazan el borrado si la cuenta tiene historial real
 * — a propósito: no hay forma de voltear de un click el negocio de un
 * cliente real, solo cuentas genuinamente vacías.
 */
export async function deleteAccount(db: QueryExecutor, id: string): Promise<boolean> {
  const result = await db.query<{ id: string }>(`DELETE FROM accounts WHERE id = $1 RETURNING id`, [id]);
  return result.rows.length > 0;
}

export async function getAccountByOwnerEmail(db: QueryExecutor, email: string): Promise<Account | null> {
  const result = await db.query<AccountRow>("SELECT * FROM accounts WHERE owner_email = $1", [
    email.trim().toLowerCase(),
  ]);
  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

export async function setAccountMlSellerId(db: QueryExecutor, accountId: string, mlSellerId: string): Promise<void> {
  await db.query("UPDATE accounts SET ml_seller_id = $1 WHERE id = $2", [mlSellerId, accountId]);
}

/** Guarda la alícuota de otros impuestos (IIBB, internos) de la cuenta. */
export async function setAccountOtherTaxRate(db: QueryExecutor, accountId: string, rate: number): Promise<void> {
  await db.query(`UPDATE accounts SET other_tax_rate = $1 WHERE id = $2`, [rate, accountId]);
}

/**
 * Marca hasta qué fecha ya se recorrió el historial completo de órdenes (ver
 * migración 018) — el próximo sync usa esto para no tener que volver a
 * recorrer años de historial que ya está al día. Si la migración todavía no
 * se corrió, no hace nada (no bloquea el sync, solo no guarda el atajo).
 */
export async function setOrdersSyncedThrough(db: QueryExecutor, accountId: string, throughDate: string): Promise<void> {
  if (!(await hasColumn(db, "accounts", "orders_synced_through"))) return;
  await db.query(`UPDATE accounts SET orders_synced_through = $1 WHERE id = $2`, [throughDate, accountId]);
}

/** Guarda el régimen fiscal de la cuenta (decide si corresponde IVA) y lo
 * marca como confirmado: ya no hace falta volver a preguntarlo. */
export async function setAccountTaxCondition(
  db: QueryExecutor,
  accountId: string,
  taxCondition: TaxCondition
): Promise<void> {
  // "confirmed" llega por una migración aparte (012): si todavía no se corrió,
  // se guarda igual el régimen y la marca de confirmado queda para la próxima.
  if (await hasColumn(db, "accounts", "tax_condition_confirmed")) {
    await db.query(
      `UPDATE accounts SET tax_condition = $1, tax_condition_confirmed = TRUE WHERE id = $2`,
      [taxCondition, accountId]
    );
  } else {
    await db.query(`UPDATE accounts SET tax_condition = $1 WHERE id = $2`, [taxCondition, accountId]);
  }
}

/**
 * La cuenta dueña de una credencial de fidelización.
 *
 * Se busca por el hash, nunca por la clave: es lo único que guardamos. La
 * política de RLS deja ver exactamente esa fila (ver `accounts_select`), así
 * que una clave equivocada no devuelve una cuenta ajena, devuelve nada.
 */
export async function getAccountByLoyaltyKeyHash(db: QueryExecutor, keyHash: string): Promise<Account | null> {
  const result = await db.query<AccountRow>(
    `SELECT * FROM accounts WHERE loyalty_api_key_hash = $1`,
    [keyHash]
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

/**
 * Guarda el hash de la credencial. Devuelve si efectivamente escribió.
 *
 * El dato importa: la política de RLS puede dejar el UPDATE en cero filas sin
 * error si el scope no corresponde al dueño. Sin este chequeo, el vendedor se
 * llevaba una clave que no quedó guardada en ningún lado y la app de la
 * billetera recibía 401 para siempre, sin ninguna pista de por qué.
 */
export async function setLoyaltyApiKeyHash(
  db: QueryExecutor,
  accountId: string,
  keyHash: string
): Promise<boolean> {
  const result = await db.query<{ id: string }>(
    `UPDATE accounts SET loyalty_api_key_hash = $1, loyalty_api_key_created_at = now()
      WHERE id = $2 RETURNING id`,
    [keyHash, accountId]
  );
  return result.rows.length > 0;
}
