import { NextRequest, NextResponse } from "next/server";
import { withScope } from "@/db/client";
import { hasColumn } from "@/db/schema-capabilities";
import { appliesIva } from "@/db/accounts";
import { resolveCurrentAccount } from "@/lib/current-account";
import { recalculateProduct } from "@/sync/sync-service";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_PRODUCTS = 200;

/**
 * Deja solo el último costo cargado de cada producto y recalcula sus ventas:
 * así un costo corregido vale también para las ventas anteriores, que hasta
 * ahora seguían con el costo viejo (mal cargado) del historial.
 */
export async function POST(request: NextRequest) {
  const account = await resolveCurrentAccount();
  if (!account) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as { productIds?: unknown };
  const ids = Array.isArray(body.productIds) ? body.productIds.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
  if (ids.length === 0) return NextResponse.json({ error: "Mandá productIds." }, { status: 400 });
  if (ids.length > MAX_PRODUCTS) return NextResponse.json({ error: `Máximo ${MAX_PRODUCTS} productos por vez.` }, { status: 400 });

  const result = await withScope({ accountId: account.id }, async (client) => {
    const hasIva = await hasColumn(client, "order_items", "iva_applied");
    let products = 0;
    let itemsUpdated = 0;
    for (const productId of ids) {
      const removed = await client.query(
        `DELETE FROM product_costs pc
          WHERE pc.account_id = $1 AND pc.product_id = $2
            AND pc.valid_from < (SELECT max(valid_from) FROM product_costs WHERE account_id = $1 AND product_id = $2)`,
        [account.id, productId]
      );
      if (!removed.rowCount) continue;
      products++;
      itemsUpdated += await recalculateProduct(client, account.id, productId, hasIva, account.otherTaxRate, appliesIva(account.taxCondition));
    }
    return { products, itemsUpdated };
  });

  return NextResponse.json({ ok: true, ...result });
}
