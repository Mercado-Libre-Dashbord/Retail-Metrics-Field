import { NextRequest, NextResponse } from "next/server";
import { withScope } from "@/db/client";
import { hasColumn, missingMigrations } from "@/db/schema-capabilities";
import { getCurrentUser, resolveCurrentAccount } from "@/lib/current-account";
import { revenueStatusFilter } from "@/lib/order-status";
import { getStoreVisits } from "@/mcp/tools";

export const runtime = "nodejs";

// Mismo largo de días, inmediatamente antes de `from` — para poder mostrar
// "+12% vs. período anterior" en las tarjetas de Resumen. Si las fechas no
// son un rango de días válido (p. ej. los defaults 1970-01-01/9999-12-31)
// no hay un "período anterior" que tenga sentido, así que se omite.
function previousRange(from: string, to: string): { from: string; to: string } | null {
  const fromD = new Date(`${from}T00:00:00Z`);
  const toD = new Date(`${to}T00:00:00Z`);
  if (Number.isNaN(fromD.getTime()) || Number.isNaN(toD.getTime()) || toD < fromD) return null;
  const days = Math.round((toD.getTime() - fromD.getTime()) / 86400000) + 1;
  const prevTo = new Date(fromD.getTime() - 86400000);
  const prevFrom = new Date(prevTo.getTime() - (days - 1) * 86400000);
  return { from: prevFrom.toISOString().slice(0, 10), to: prevTo.toISOString().slice(0, 10) };
}

async function totalsFor(client: { query: (sql: string, args: unknown[]) => Promise<{ rows: Record<string, string | number>[] }> }, accountId: string, from: string, to: string) {
  const totalsResult = await client.query(
    `SELECT
       COUNT(DISTINCT o.id) as orders,
       COALESCE(SUM(oi.unit_price * oi.quantity), 0) as "grossSales",
       COALESCE(SUM(oi.net_profit), 0) as "netProfit"
     FROM order_items oi
     JOIN orders o ON o.account_id = oi.account_id AND o.id = oi.order_id
     WHERE oi.account_id = $1 AND o.date_created::date BETWEEN $2::date AND $3::date
       AND ${revenueStatusFilter()}`,
    [accountId, from, to]
  );
  const row = totalsResult.rows[0];
  const orders = Number(row.orders);
  const grossSales = Number(row.grossSales);
  const netProfit = Number(row.netProfit);
  const refunds = await refundsFor(client, accountId, from, to);
  return {
    orders,
    grossSales,
    netProfit,
    profitPct: grossSales > 0 ? netProfit / grossSales : 0,
    refundOrders: refunds.orders,
    refundAmount: refunds.amount,
  };
}

/**
 * Órdenes canceladas del período: cuántas y por cuánta plata.
 *
 * Quedan fuera de facturación y ganancia (ver lib/order-status.ts), pero
 * necesitan verse igual: una cancelación es trabajo hecho que no se cobró,
 * y una tasa que sube es una señal temprana de un problema de producto,
 * stock o envío.
 */
async function refundsFor(
  client: { query: (sql: string, args: unknown[]) => Promise<{ rows: Record<string, string | number>[] }> },
  accountId: string,
  from: string,
  to: string
) {
  const result = await client.query(
    `SELECT COUNT(DISTINCT o.id) as orders,
            COALESCE(SUM(oi.unit_price * oi.quantity), 0) as amount
     FROM orders o
     JOIN order_items oi ON oi.account_id = o.account_id AND oi.order_id = o.id
     WHERE o.account_id = $1 AND o.date_created::date BETWEEN $2::date AND $3::date
       AND NOT (${revenueStatusFilter()})`,
    [accountId, from, to]
  );
  const row = result.rows[0];
  return { orders: Number(row.orders ?? 0), amount: Number(row.amount ?? 0) };
}

export async function GET(request: NextRequest) {
  const account = await resolveCurrentAccount();
  if (!account) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const { searchParams } = request.nextUrl;
  const from = searchParams.get("from") ?? "1970-01-01";
  const to = searchParams.get("to") ?? "9999-12-31";
  const groupBy = searchParams.get("groupBy");

  if (groupBy === "month") {
    const rows = await withScope({ accountId: account.id }, async (client) => {
      const result = await client.query(
        `SELECT to_char(o.date_created, 'YYYY-MM') as month, COALESCE(SUM(oi.net_profit), 0) as "netProfit"
         FROM order_items oi JOIN orders o ON o.account_id = oi.account_id AND o.id = oi.order_id
         WHERE oi.account_id = $1 AND o.date_created::date BETWEEN $2::date AND $3::date
           AND ${revenueStatusFilter()}
         GROUP BY month ORDER BY month`,
        [account.id, from, to]
      );
      return result.rows;
    });
    return NextResponse.json(rows);
  }

  if (groupBy === "day") {
    const rows = await withScope({ accountId: account.id }, async (client) => {
      // Sin la migración de impuestos el gráfico se dibuja igual con la franja
      // de impuestos en cero, en vez de quedarse cargando para siempre.
      const taxSum = (await hasColumn(client, "order_items", "tax_applied"))
        ? "COALESCE(SUM(oi.tax_applied * oi.quantity), 0)"
        : "0::double precision";
      const ivaSum = (await hasColumn(client, "order_items", "iva_applied"))
        ? "COALESCE(SUM(oi.iva_applied), 0)"
        : "0::double precision";

      const result = await client.query(
        `SELECT to_char(o.date_created, 'YYYY-MM-DD') as day,
                COALESCE(SUM(oi.unit_price * oi.quantity), 0) as revenue,
                COALESCE(SUM(oi.ml_commission), 0) as commission,
                COALESCE(SUM(oi.shipping_cost), 0) as shipping,
                COALESCE(SUM(oi.cost_applied * oi.quantity), 0) as cost,
                COALESCE(SUM(oi.ads_cost_allocated), 0) as ads,
                ${taxSum} as tax,
                ${ivaSum} as iva,
                COALESCE(SUM(oi.net_profit), 0) as "netProfit"
         FROM order_items oi JOIN orders o ON o.account_id = oi.account_id AND o.id = oi.order_id
         WHERE oi.account_id = $1 AND o.date_created::date BETWEEN $2::date AND $3::date
           AND ${revenueStatusFilter()}
         GROUP BY day ORDER BY day`,
        [account.id, from, to]
      );
      return result.rows;
    });
    return NextResponse.json(rows);
  }

  if (groupBy === "trend") {
    const rows = await withScope({ accountId: account.id }, async (client) => {
      // Frecuencia de venta (unidades por día) en la mitad reciente del
      // período contra la mitad anterior. Se compara por ritmo y no por total
      // para que dos mitades de distinto largo sigan siendo comparables.
      const result = await client.query(
        `WITH bounds AS (
           SELECT $2::date AS from_date, $3::date AS to_date,
                  ($2::date + ((($3::date - $2::date) + 1) / 2)) AS mid_date
         )
         SELECT p.id, p.title, ${(await hasColumn(client, "products", "thumbnail")) ? "p.thumbnail" : "NULL::text"} as thumbnail,
                COALESCE(SUM(CASE WHEN o.date_created::date >= b.mid_date THEN oi.quantity ELSE 0 END), 0) as "recentUnits",
                COALESCE(SUM(CASE WHEN o.date_created::date <  b.mid_date THEN oi.quantity ELSE 0 END), 0) as "previousUnits",
                GREATEST((b.to_date - b.mid_date) + 1, 1) as "recentDays",
                GREATEST(b.mid_date - b.from_date, 1) as "previousDays"
         FROM order_items oi
         JOIN orders o ON o.account_id = oi.account_id AND o.id = oi.order_id
         JOIN products p ON p.account_id = oi.account_id AND p.id = oi.product_id
         CROSS JOIN bounds b
         WHERE oi.account_id = $1 AND o.date_created::date BETWEEN b.from_date AND b.to_date
           AND ${revenueStatusFilter()}
         GROUP BY p.id, p.title, thumbnail, b.to_date, b.mid_date, b.from_date
         HAVING COALESCE(SUM(oi.quantity), 0) > 0`,
        [account.id, from, to]
      );

      return result.rows.map((r: Record<string, string | number | null>) => {
        const recentRate = Number(r.recentUnits) / Number(r.recentDays);
        const previousRate = Number(r.previousUnits) / Number(r.previousDays);
        return {
          id: r.id,
          title: r.title,
          thumbnail: r.thumbnail,
          recentUnits: Number(r.recentUnits),
          previousUnits: Number(r.previousUnits),
          recentRate,
          previousRate,
          // Sin ventas antes, cualquier venta nueva es un producto que arranca:
          // se marca como tal en vez de un porcentaje infinito.
          changePct: previousRate > 0 ? (recentRate - previousRate) / previousRate : null,
        };
      });
    });
    return NextResponse.json(rows);
  }

  const summary = await withScope({ accountId: account.id }, async (client) => {
    const totalsResult = await client.query(
      `SELECT
         COUNT(DISTINCT o.id) as orders,
         COALESCE(SUM(oi.unit_price * oi.quantity), 0) as "grossSales",
         COALESCE(SUM(oi.ml_commission), 0) as "totalCommission",
         COALESCE(SUM(oi.shipping_cost), 0) as "totalShipping",
         COALESCE(SUM(oi.cost_applied * oi.quantity), 0) as "totalCost",
         ${(await hasColumn(client, "order_items", "iva_applied")) ? "COALESCE(SUM(oi.iva_applied), 0)" : "0::double precision"} as "totalIva",
         COALESCE(SUM(oi.net_profit), 0) as "netProfit",
         SUM(CASE WHEN oi.cost_applied IS NULL THEN 1 ELSE 0 END) as "itemsMissingCost",
         COUNT(DISTINCT CASE WHEN oi.cost_applied IS NOT NULL THEN o.id END) as "ordersWithCost"
       FROM order_items oi
       JOIN orders o ON o.account_id = oi.account_id AND o.id = oi.order_id
       WHERE oi.account_id = $1 AND o.date_created::date BETWEEN $2::date AND $3::date
         AND ${revenueStatusFilter()}`,
      [account.id, from, to]
    );
    const totals = totalsResult.rows[0] as Record<string, string | number>;

    // El Ad Spend de la tarjeta sale directo de ads_spend (todo lo cargado,
    // de cualquier canal) — no de sumar oi.ads_cost_allocated (el gasto ya
    // repartido entre las ventas), que puede quedar corto si hubo gasto en
    // Ads un día sin ninguna venta ese día para repartírselo.
    const adSpendResult = await client.query(
      `SELECT COALESCE(SUM(amount), 0) as total FROM ads_spend
       WHERE account_id = $1 AND date BETWEEN $2::date AND $3::date`,
      [account.id, from, to]
    );
    const adSpend = Number(adSpendResult.rows[0].total);
    const revenue = Number(totals.grossSales);
    const orders = Number(totals.orders);
    const netProfit = Number(totals.netProfit);
    const ordersWithCost = Number(totals.ordersWithCost);

    const refunds = await refundsFor(client, account.id, from, to);

    // Qué productos, no solo cuántas líneas. Un contador suelto —"12 líneas
    // sin costo cargado"— es un callejón sin salida: el vendedor jura que los
    // cargó todos y no tiene forma de saber cuál falta. Casi siempre son
    // publicaciones que ya no están activas, así que ni siquiera las estaba
    // viendo en la lista.
    const missingThumb = (await hasColumn(client, "products", "thumbnail")) ? "p.thumbnail" : "NULL::text";
    const missingCostResult = await client.query(
      `SELECT oi.product_id as "productId",
              COALESCE(p.title, oi.product_id) as title,
              ${missingThumb} as thumbnail,
              COALESCE(SUM(oi.quantity), 0)::int as units
         FROM order_items oi
         JOIN orders o ON o.account_id = oi.account_id AND o.id = oi.order_id
         LEFT JOIN products p ON p.account_id = oi.account_id AND p.id = oi.product_id
        WHERE oi.account_id = $1 AND o.date_created::date BETWEEN $2::date AND $3::date
          AND ${revenueStatusFilter()} AND oi.cost_applied IS NULL
        GROUP BY oi.product_id, p.title, ${missingThumb}
        ORDER BY SUM(oi.quantity) DESC
        LIMIT 8`,
      [account.id, from, to]
    );
    const productsMissingCost = missingCostResult.rows as {
      productId: string; title: string; thumbnail: string | null; units: number;
    }[];

    // Las visitas salen de la API de ML en vivo, no de nuestra base: no hay
    // histórico que guardar y el dato es del período que se está mirando.
    const visits =
      account.mlSellerId && from !== "1970-01-01"
        ? await getStoreVisits(account.id, account.mlSellerId, from, to)
        : null;

    const prevRange = previousRange(from, to);
    const previous = prevRange ? await totalsFor(client, account.id, prevRange.from, prevRange.to) : null;

    // Solo para el dueño de la app (admin): avisa en la UI que falta correr
    // una migración, con el SQL exacto. El cliente final nunca lo ve.
    const user = await getCurrentUser();
    const pendingMigrations = user?.isAdmin ? (await missingMigrations(client)).map((m) => m.ddl) : [];

    return {
      orders,
      grossSales: revenue,
      aov: orders > 0 ? revenue / orders : 0,
      netProfit,
      profitPct: revenue > 0 ? netProfit / revenue : 0,
      netRevenue: revenue - Number(totals.totalCommission) - Number(totals.totalShipping),
      totalCommission: Number(totals.totalCommission),
      totalShipping: Number(totals.totalShipping),
      totalCost: Number(totals.totalCost),
      totalIva: Number(totals.totalIva),
      adSpend,
      mer: adSpend > 0 ? revenue / adSpend : 0,
      roas: adSpend > 0 ? revenue / adSpend : 0,
      cpa: orders > 0 ? adSpend / orders : 0,
      netAov: orders > 0 ? netProfit / orders : 0,
      trueCpa: ordersWithCost > 0 ? adSpend / ordersWithCost : 0,
      itemsMissingCost: Number(totals.itemsMissingCost),
      productsMissingCost,
      refundOrders: refunds.orders,
      refundAmount: refunds.amount,
      refundRate: orders + refunds.orders > 0 ? refunds.orders / (orders + refunds.orders) : 0,
      visits,
      // De cada 100 visitas, cuántas terminaron en venta.
      conversionRate: visits && visits > 0 ? orders / visits : null,
      previous,
      pendingMigrations,
    };
  });

  return NextResponse.json(summary);
}
