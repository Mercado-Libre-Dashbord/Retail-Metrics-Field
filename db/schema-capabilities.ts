import type { QueryExecutor } from "./client";

/**
 * Qué columnas existen realmente en la base, para poder degradar en vez de
 * tirar 500 cuando falta una migración.
 *
 * Contexto: las columnas `product_costs.tax` y `order_items.tax_applied` se
 * agregan corriendo db/postgres/schema.sql a mano. Si eso todavía no se
 * corrió (o se corrió contra otra base), las queries que las nombran fallan
 * con "column does not exist" y la página entera queda rota — que fue
 * exactamente lo que pasó en producción: Productos dejó de cargar y pareció
 * que se habían borrado los costos, cuando en realidad seguían guardados.
 *
 * El cache tiene TTL corto a propósito: cuando alguien corre la migración,
 * las instancias que ya estaban calientes se recuperan solas en <1 minuto
 * sin necesidad de redeployar.
 */
const TTL_MS = 60_000;

let cache: { at: number; columns: Set<string> } | null = null;

export async function getPublicColumns(client: QueryExecutor): Promise<Set<string>> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.columns;
  const result = await client.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`
  );
  const columns = new Set(result.rows.map((r) => `${r.table_name}.${r.column_name}`));
  cache = { at: Date.now(), columns };
  return columns;
}

export async function hasColumn(client: QueryExecutor, table: string, column: string): Promise<boolean> {
  return (await getPublicColumns(client)).has(`${table}.${column}`);
}

/** Columnas que el código espera y que se agregan por migración manual. */
export const EXPECTED_COLUMNS: { table: string; column: string; ddl: string }[] = [
  {
    table: "product_costs",
    column: "tax",
    ddl: "ALTER TABLE product_costs ADD COLUMN IF NOT EXISTS tax DOUBLE PRECISION NOT NULL DEFAULT 0;",
  },
  {
    table: "order_items",
    column: "tax_applied",
    ddl: "ALTER TABLE order_items ADD COLUMN IF NOT EXISTS tax_applied DOUBLE PRECISION;",
  },
  {
    table: "order_items",
    column: "iva_applied",
    ddl: "ALTER TABLE order_items ADD COLUMN IF NOT EXISTS iva_applied DOUBLE PRECISION;",
  },
  {
    table: "products",
    column: "category_id",
    ddl: "ALTER TABLE products ADD COLUMN IF NOT EXISTS category_id TEXT;",
  },
  {
    table: "products",
    column: "category_name",
    ddl: "ALTER TABLE products ADD COLUMN IF NOT EXISTS category_name TEXT;",
  },
  {
    table: "orders",
    column: "sync_version",
    ddl: "ALTER TABLE orders ADD COLUMN IF NOT EXISTS sync_version INTEGER NOT NULL DEFAULT 0;",
  },
  {
    table: "accounts",
    column: "other_tax_rate",
    ddl: "ALTER TABLE accounts ADD COLUMN IF NOT EXISTS other_tax_rate DOUBLE PRECISION NOT NULL DEFAULT 0;",
  },
  {
    table: "products",
    column: "thumbnail",
    ddl: "ALTER TABLE products ADD COLUMN IF NOT EXISTS thumbnail TEXT;",
  },
  {
    // La tabla entera llega por migración; se detecta por una columna suya.
    table: "billing_charges",
    column: "detail_id",
    ddl: "-- Falta la tabla billing_charges: corré db/postgres/migrations/002-iva-y-facturacion.sql",
  },
  {
    table: "accounts",
    column: "loyalty_api_key_hash",
    ddl: "-- Correr db/postgres/migrations/010-loyalty-api-key.sql (agrega columnas, función y política).",
  },
  {
    table: "accounts",
    column: "tax_condition",
    ddl: "-- Correr db/postgres/migrations/011-regimen-fiscal.sql (decide si corresponde calcular IVA).",
  },
  {
    table: "accounts",
    column: "tax_condition_confirmed",
    ddl: "-- Correr db/postgres/migrations/012-regimen-fiscal-confirmado.sql (para preguntarlo una sola vez).",
  },
  {
    table: "products",
    column: "logistic_type",
    ddl: "-- Correr db/postgres/migrations/013-full-logistica.sql (para saber qué productos están en Full).",
  },
  {
    table: "products",
    column: "inventory_id",
    ddl: "ALTER TABLE products ADD COLUMN IF NOT EXISTS inventory_id TEXT;",
  },
  {
    table: "products",
    column: "full_stock_qty",
    ddl: "ALTER TABLE products ADD COLUMN IF NOT EXISTS full_stock_qty INTEGER;",
  },
  {
    table: "products",
    column: "full_stock_unavailable_qty",
    ddl: "ALTER TABLE products ADD COLUMN IF NOT EXISTS full_stock_unavailable_qty INTEGER;",
  },
  {
    table: "products",
    column: "low_stock_threshold",
    ddl: "-- Correr db/postgres/migrations/014-alerta-stock-bajo.sql (alertas de stock bajo por producto).",
  },
  {
    table: "products",
    column: "full_since",
    ddl: "-- Correr db/postgres/migrations/015-full-antiguedad.sql (antigüedad estimada en Full).",
  },
  {
    // La tabla entera llega por migración; se detecta por una columna suya.
    table: "credential_users",
    column: "email",
    ddl: "-- Correr db/postgres/migrations/016-login-credenciales.sql (login con email y contraseña).",
  },
  {
    table: "accounts",
    column: "orders_synced_through",
    ddl: "-- Correr db/postgres/migrations/018-orders-synced-through.sql (sync incremental de órdenes).",
  },
  {
    table: "product_costs",
    column: "exchange_rate",
    ddl: "-- Correr db/postgres/migrations/019-costo-en-dolares.sql (costo cargado en pesos y en dólares).",
  },
  {
    table: "product_costs",
    column: "cost_currency",
    ddl: "-- Correr db/postgres/migrations/019-costo-en-dolares.sql (costo cargado en pesos y en dólares).",
  },
];

export async function missingMigrations(client: QueryExecutor): Promise<{ table: string; column: string; ddl: string }[]> {
  const columns = await getPublicColumns(client);
  return EXPECTED_COLUMNS.filter((c) => !columns.has(`${c.table}.${c.column}`));
}

/** Solo para tests. */
export function resetColumnCache(): void {
  cache = null;
}
