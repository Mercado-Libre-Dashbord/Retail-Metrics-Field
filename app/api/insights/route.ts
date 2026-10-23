import { NextRequest, NextResponse } from "next/server";
import { withScope, type QueryExecutor } from "@/db/client";
import { hasColumn } from "@/db/schema-capabilities";
import { appliesIva } from "@/db/accounts";
import { resolveCurrentAccount } from "@/lib/current-account";
import { revenueStatusFilter } from "@/lib/order-status";
import { buildInsights, type Breakdown } from "@/lib/insights";
import { periodAdjustments } from "@/sync/period-charges";

export const runtime = "nodejs";

/** El mismo período inmediatamente anterior, del mismo largo (como en /api/summary). */
function previousRange(from: string, to: string): { from: string; to: string } | null {
  const f = new Date(`${from}T00:00:00Z`);
  const t = new Date(`${to}T00:00:00Z`);
  if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime()) || t < f || from === "1970-01-01") return null;
  const days = Math.round((t.getTime() - f.getTime()) / 86400000) + 1;
  const prevTo = new Date(f.getTime() - 86400000);
  const prevFrom = new Date(prevTo.getTime() - (days - 1) * 86400000);
  return { from: prevFrom.toISOString().slice(0, 10), to: prevTo.toISOString().slice(0, 10) };
}

async function breakdown(db: QueryExecutor, accountId: string, from: string, to: string, withIva: boolean): Promise<Breakdown> {
  const hasTax = await hasColumn(db, "order_items", "tax_applied");
  const hasIvaCol = await hasColumn(db, "order_items", "iva_applied");
  const r = await db.query<Record<string, string | number>>(
    `SELECT COALESCE(SUM(oi.unit_price * oi.quantity), 0) as revenue,
            COALESCE(SUM(oi.ml_commission), 0) as commission,
            COALESCE(SUM(oi.shipping_cost), 0) as shipping,
            COALESCE(SUM(oi.cost_applied * oi.quantity), 0) as cost,
            COALESCE(SUM(oi.ads_cost_allocated), 0) as ads,
            ${hasTax ? "COALESCE(SUM(oi.tax_applied * oi.quantity), 0)" : "0"} +
            ${hasIvaCol ? "COALESCE(SUM(oi.iva_applied), 0)" : "0"} as taxes,
            COALESCE(SUM(oi.net_profit), 0) as net
       FROM order_items oi JOIN orders o ON o.account_id = oi.account_id AND o.id = oi.order_id
      WHERE oi.account_id = $1 AND o.date_created::date BETWEEN $2::date AND $3::date AND ${revenueStatusFilter()}`,
    [accountId, from, to]
  );
  const row = r.rows[0];
  const adj = await periodAdjustments(db, accountId, from, to, withIva);
  return {
    revenue: Number(row.revenue),
    commission: Number(row.commission),
    shipping: Number(row.shipping),
    cost: Number(row.cost),
    ads: Number(row.ads) + adj.adsNotInSales,
    taxes: Number(row.taxes) - adj.ivaCredit,
    netProfit: Number(row.net) + adj.total,
  };
}

/**
 * Hasta cuatro conclusiones del período, con su acción (ver lib/insights.ts).
 */
export async function GET(request: NextRequest) {
  const account = await resolveCurrentAccount();
  if (!account) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  const sp = request.nextUrl.searchParams;
  const from = sp.get("from") ?? "1970-01-01";
  const to = sp.get("to") ?? "9999-12-31";
  const withIva = appliesIva(account.taxCondition);

  const insights = await withScope({ accountId: account.id }, async (client) => {
    const current = await breakdown(client, account.id, from, to, withIva);
    if (current.revenue <= 0) return [];
    const prevRange = previousRange(from, to);
    const previous = prevRange ? await breakdown(client, account.id, prevRange.from, prevRange.to, withIva) : null;

    const perProduct = await client.query<{ title: string; units: string | number; profit: string | number; missing: string | number }>(
      `SELECT COALESCE(MAX(p.title), oi.product_id) as title, SUM(oi.quantity) as units,
              COALESCE(SUM(oi.net_profit), 0) as profit, COUNT(*) FILTER (WHERE oi.net_profit IS NULL) as missing
         FROM order_items oi JOIN orders o ON o.account_id = oi.account_id AND o.id = oi.order_id
         LEFT JOIN products p ON p.account_id = oi.account_id AND p.id = oi.product_id
        WHERE oi.account_id = $1 AND o.date_created::date BETWEEN $2::date AND $3::date AND ${revenueStatusFilter()}
        GROUP BY oi.product_id`,
      [account.id, from, to]
    );
    const rows = perProduct.rows.map((r) => ({ title: r.title, units: Number(r.units), profit: Number(r.profit), missing: Number(r.missing) }));
    const priced = rows.filter((r) => r.missing === 0);
    const losing = priced.filter((r) => r.profit < 0).sort((a, b) => a.profit - b.profit);
    const best = priced.filter((r) => r.profit > 0).sort((a, b) => b.profit - a.profit)[0] ?? null;

    const missing = await client.query<{ products: string | number; units: string | number; revenue: string | number }>(
      `SELECT COUNT(DISTINCT oi.product_id) as products, COALESCE(SUM(oi.quantity), 0) as units,
              COALESCE(SUM(oi.unit_price * oi.quantity), 0) as revenue
         FROM order_items oi JOIN orders o ON o.account_id = oi.account_id AND o.id = oi.order_id
        WHERE oi.account_id = $1 AND o.date_created::date BETWEEN $2::date AND $3::date
          AND ${revenueStatusFilter()} AND oi.cost_applied IS NULL`,
      [account.id, from, to]
    );

    let idleFull = { products: 0, units: 0, capital: 0, top: null as string | null };
    if (await hasColumn(client, "products", "full_stock_qty")) {
      const idle = await client.query<{ title: string; units: string | number; capital: string | number }>(
        `SELECT p.title, (p.full_stock_qty + COALESCE(p.full_stock_unavailable_qty, 0)) as units,
                (p.full_stock_qty + COALESCE(p.full_stock_unavailable_qty, 0)) * lc.cost as capital
           FROM products p
           JOIN LATERAL (SELECT cost FROM product_costs pc WHERE pc.account_id = p.account_id AND pc.product_id = p.id
                          ORDER BY valid_from DESC LIMIT 1) lc ON true
          WHERE p.account_id = $1 AND p.logistic_type = 'fulfillment' AND p.full_stock_qty > 0
            AND NOT EXISTS (
              SELECT 1 FROM order_items oi JOIN orders o ON o.account_id = oi.account_id AND o.id = oi.order_id
               WHERE oi.account_id = p.account_id AND oi.product_id = p.id AND ${revenueStatusFilter()}
                 AND o.date_created >= LEAST($2::date, now()::date) - interval '30 days')
          ORDER BY capital DESC`,
        [account.id, to]
      );
      idleFull = {
        products: idle.rows.length,
        units: idle.rows.reduce((s, r) => s + Number(r.units), 0),
        capital: idle.rows.reduce((s, r) => s + Number(r.capital), 0),
        top: idle.rows[0]?.title ?? null,
      };
    }

    const m = missing.rows[0];
    return buildInsights({
      current,
      previous: previous && previous.revenue > 0 ? previous : null,
      losing: losing.map(({ title, units, profit }) => ({ title, units, profit })),
      missingCost: { products: Number(m.products), units: Number(m.units), revenue: Number(m.revenue) },
      idleFull,
      best: best ? { title: best.title, profit: best.profit } : null,
    });
  });

  return NextResponse.json(insights);
}
