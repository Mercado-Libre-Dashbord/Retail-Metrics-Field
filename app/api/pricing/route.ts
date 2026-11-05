import { NextRequest, NextResponse } from "next/server";
import { withScope } from "@/db/client";
import { hasColumn } from "@/db/schema-capabilities";
import { resolveCurrentAccount } from "@/lib/current-account";
import { revenueStatusFilter } from "@/lib/order-status";
import { computePricing, ratesFrom, type SalesTotals } from "@/lib/pricing";

export const runtime = "nodejs";

/**
 * Piso y precio sugerido de cada publicación, con las tasas reales de sus
 * ventas recientes (ver lib/pricing.ts).
 *
 * ?target=0.2  margen objetivo (0 a 0,6)
 * ?days=90     período de referencia para las tasas
 * ?ads=0       no contar la publicidad
 */
export async function GET(request: NextRequest) {
  const account = await resolveCurrentAccount();
  if (!account) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const sp = request.nextUrl.searchParams;
  const target = Math.min(0.6, Math.max(0, Number(sp.get("target") ?? 0.2) || 0));
  const days = Math.min(365, Math.max(7, Math.round(Number(sp.get("days") ?? 90) || 90)));
  const includeAds = sp.get("ads") !== "0";

  const data = await withScope({ accountId: account.id }, async (client) => {
    const ivaExpr = (await hasColumn(client, "order_items", "iva_applied")) ? "oi.iva_applied" : "0";
    const taxExpr = (await hasColumn(client, "order_items", "tax_applied")) ? "oi.tax_applied * oi.quantity" : "0";
    const thumb = (await hasColumn(client, "products", "thumbnail")) ? "p.thumbnail" : "NULL::text";
    const sales = await client.query(
      `SELECT oi.product_id as id,
              COALESCE(SUM(oi.quantity), 0) as units,
              COALESCE(SUM(oi.unit_price * oi.quantity), 0) as revenue,
              COALESCE(SUM(oi.ml_commission), 0) as commission,
              COALESCE(SUM(oi.shipping_cost), 0) as shipping,
              COALESCE(SUM(${ivaExpr}), 0) as iva,
              COALESCE(SUM(${taxExpr}), 0) as tax,
              COALESCE(SUM(oi.ads_cost_allocated), 0) as ads
         FROM order_items oi JOIN orders o ON o.account_id = oi.account_id AND o.id = oi.order_id
        WHERE oi.account_id = $1 AND o.date_created >= now() - ($2::int * interval '1 day')
          AND ${revenueStatusFilter()}
        GROUP BY oi.product_id`,
      [account.id, days]
    );
    const products = await client.query(
      `SELECT p.id, p.title, p.sku, p.current_price as price, p.stock, p.permalink, ${thumb} as thumbnail,
              (SELECT cost FROM product_costs pc WHERE pc.account_id = p.account_id AND pc.product_id = p.id ORDER BY pc.valid_from DESC LIMIT 1) as cost,
              (SELECT valid_from FROM product_costs pc WHERE pc.account_id = p.account_id AND pc.product_id = p.id ORDER BY pc.valid_from DESC LIMIT 1) as "costSince"
         FROM products p
        WHERE p.account_id = $1 AND COALESCE(p.current_price, 0) > 0`,
      [account.id]
    );
    return { sales: sales.rows, products: products.rows };
  });

  const toTotals = (r: Record<string, unknown> | undefined): SalesTotals => ({
    units: Number(r?.units ?? 0),
    revenue: Number(r?.revenue ?? 0),
    commission: Number(r?.commission ?? 0),
    shipping: Number(r?.shipping ?? 0),
    iva: Number(r?.iva ?? 0),
    tax: Number(r?.tax ?? 0),
    ads: Number(r?.ads ?? 0),
  });
  const byId = new Map(data.sales.map((r: Record<string, unknown>) => [String(r.id), toTotals(r)]));
  const accountTotals = [...byId.values()].reduce<SalesTotals>(
    (a, t) => ({
      units: a.units + t.units, revenue: a.revenue + t.revenue, commission: a.commission + t.commission,
      shipping: a.shipping + t.shipping, iva: a.iva + t.iva, tax: a.tax + t.tax, ads: a.ads + t.ads,
    }),
    { units: 0, revenue: 0, commission: 0, shipping: 0, iva: 0, tax: 0, ads: 0 }
  );

  const rows = data.products.map((p: Record<string, unknown>) => {
    const own = byId.get(String(p.id)) ?? toTotals(undefined);
    const price = Number(p.price);
    const cost = p.cost === null || p.cost === undefined ? null : Number(p.cost);
    const rates = ratesFrom(own, accountTotals);
    return {
      id: String(p.id),
      title: String(p.title ?? p.id),
      sku: (p.sku as string | null) ?? null,
      thumbnail: (p.thumbnail as string | null) ?? null,
      permalink: (p.permalink as string | null) ?? null,
      stock: Number(p.stock ?? 0),
      price,
      cost,
      costSince: p.costSince ? new Date(p.costSince as string).toISOString() : null,
      unitsSold: own.units,
      ...computePricing(price, cost, rates, target, { includeAds }),
    };
  });

  const counts = rows.reduce<Record<string, number>>((acc, r) => ((acc[r.status] = (acc[r.status] ?? 0) + 1), acc), {});
  return NextResponse.json({ target, days, includeAds, counts, rows });
}
