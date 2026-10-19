import { NextRequest, NextResponse } from "next/server";
import { withScope } from "@/db/client";
import { hasColumn } from "@/db/schema-capabilities";
import { appliesIva } from "@/db/accounts";
import { resolveCurrentAccount } from "@/lib/current-account";
import { recalculateProduct } from "@/sync/sync-service";

export const runtime = "nodejs";
export const maxDuration = 60;

/** El navegador manda de a tandas chicas: cada costo recalcula las ventas del producto. */
const MAX_ITEMS_PER_REQUEST = 40;

interface ImportItem {
  productId: string;
  cost: number;
}

/**
 * Carga de costos en lote (ver lib/cost-import.ts). Cada ítem hace lo mismo que
 * un PATCH /api/products con `cost`: agrega una fila al historial de costos y
 * recalcula las ventas de ese producto. Si el producto ya tiene exactamente ese
 * costo no se agrega nada, para no ensuciar el historial al reimportar el mismo
 * archivo.
 */
export async function POST(request: NextRequest) {
  const account = await resolveCurrentAccount();
  if (!account) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as { items?: unknown; validFrom?: unknown };
  // Fecha desde la que vale el costo: la de la planilla (por ejemplo, la fecha
  // de corte del stock), así el historial de costos queda bien aunque se suba
  // una planilla vieja. Sin fecha, vale desde ahora.
  let validFrom = new Date().toISOString();
  if (body.validFrom !== undefined && body.validFrom !== null) {
    const ok = typeof body.validFrom === "string" && /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(body.validFrom);
    const asDate = ok ? new Date(`${body.validFrom}T03:00:00Z`) : null;
    if (!asDate || Number.isNaN(asDate.getTime()) || asDate.getTime() > Date.now() + 86_400_000 || asDate.getUTCFullYear() < 2000) {
      return NextResponse.json({ error: "validFrom tiene que ser una fecha AAAA-MM-DD, no futura." }, { status: 400 });
    }
    validFrom = asDate.toISOString();
  }
  if (!Array.isArray(body.items) || body.items.length === 0) {
    return NextResponse.json({ error: "Mandá items con al menos un costo." }, { status: 400 });
  }
  if (body.items.length > MAX_ITEMS_PER_REQUEST) {
    return NextResponse.json({ error: `Máximo ${MAX_ITEMS_PER_REQUEST} costos por pedido.` }, { status: 400 });
  }
  const items: ImportItem[] = [];
  for (const raw of body.items as Partial<ImportItem>[]) {
    if (!raw || typeof raw.productId !== "string" || !raw.productId || typeof raw.cost !== "number" || !Number.isFinite(raw.cost) || raw.cost < 0) {
      return NextResponse.json({ error: "Cada ítem necesita productId y un cost numérico >= 0." }, { status: 400 });
    }
    items.push({ productId: raw.productId, cost: raw.cost });
  }

  const result = await withScope({ accountId: account.id }, async (client) => {
    const hasFx = await hasColumn(client, "product_costs", "exchange_rate");
    const hasIva = await hasColumn(client, "order_items", "iva_applied");
    let updated = 0;
    let unchanged = 0;
    let missing = 0;
    let itemsUpdated = 0;
    for (const item of items) {
      const current = await client.query<{ cost: number | null }>(
        `SELECT (SELECT cost FROM product_costs pc WHERE pc.account_id = p.account_id AND pc.product_id = p.id ORDER BY pc.valid_from DESC LIMIT 1) as cost
           FROM products p WHERE p.account_id = $1 AND p.id = $2`,
        [account.id, item.productId]
      );
      if (current.rows.length === 0) { missing++; continue; }
      const currentCost = current.rows[0].cost;
      if (currentCost !== null && currentCost !== undefined && Math.abs(Number(currentCost) - item.cost) < 0.005) { unchanged++; continue; }
      if (hasFx) {
        await client.query(
          `INSERT INTO product_costs (account_id, product_id, cost, valid_from, exchange_rate, cost_currency) VALUES ($1, $2, $3, $4, NULL, 'ARS')`,
          [account.id, item.productId, item.cost, validFrom]
        );
      } else {
        await client.query(`INSERT INTO product_costs (account_id, product_id, cost, valid_from) VALUES ($1, $2, $3, $4)`, [account.id, item.productId, item.cost, validFrom]);
      }
      itemsUpdated += await recalculateProduct(client, account.id, item.productId, hasIva, account.otherTaxRate, appliesIva(account.taxCondition));
      updated++;
    }
    return { updated, unchanged, missing, itemsUpdated };
  });

  return NextResponse.json({ ok: true, ...result });
}
