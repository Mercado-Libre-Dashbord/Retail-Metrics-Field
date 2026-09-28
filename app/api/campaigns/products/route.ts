import { NextRequest, NextResponse } from "next/server";
import { withScope } from "@/db/client";
import { resolveCurrentAccount } from "@/lib/current-account";
import { revenueStatusFilter } from "@/lib/order-status";
import { recommendAdsAction, type AdsRecommendation } from "@/lib/ads-recommendation";

export const runtime = "nodejs";

export interface AdsProductPerformance {
  productId: string;
  title: string;
  revenue: number;
  adSpend: number;
  netProfit: number;
  /** Facturación ÷ Publicidad. Null sin gasto (no debería pasar: la
   * consulta ya filtra a productos con adSpend > 0). */
  roas: number | null;
  recommendation: AdsRecommendation;
}

/**
 * Rendimiento real de Ads por publicación, para decidir a cuál seguir
 * pagando, a cuál sacarle presupuesto, y a cuál ponerle más plata — no solo
 * mirar el total de la cuenta.
 *
 * Depende de que ads_spend tenga product_id real (no solo agregado a nivel
 * cuenta): eso solo existe para los últimos ~90 días, el límite que da la
 * API de Mercado Ads para el gasto por publicación puntual (ver getAdsSpend
 * en mcp/tools.ts). Para un período más viejo, esta lista sale vacía — no
 * es un error, es que ese dato ya no existe del lado de Mercado Libre.
 */
export async function GET(request: NextRequest) {
  const account = await resolveCurrentAccount();
  if (!account) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const { searchParams } = request.nextUrl;
  const from = searchParams.get("from") ?? "1970-01-01";
  const to = searchParams.get("to") ?? "9999-12-31";

  const rows = await withScope({ accountId: account.id }, async (client) => {
    const result = await client.query<{ productId: string; title: string; revenue: number; adSpend: number; netProfit: number }>(
      `SELECT oi.product_id as "productId", COALESCE(p.title, oi.product_id) as title,
              COALESCE(SUM(oi.unit_price * oi.quantity), 0) as revenue,
              COALESCE(SUM(oi.ads_cost_allocated), 0) as "adSpend",
              COALESCE(SUM(oi.net_profit), 0) as "netProfit"
         FROM order_items oi
         JOIN orders o ON o.account_id = oi.account_id AND o.id = oi.order_id
         LEFT JOIN products p ON p.account_id = oi.account_id AND p.id = oi.product_id
        WHERE oi.account_id = $1 AND o.date_created::date BETWEEN $2::date AND $3::date
          AND ${revenueStatusFilter()}
        GROUP BY oi.product_id, p.title
       HAVING COALESCE(SUM(oi.ads_cost_allocated), 0) > 0
        ORDER BY "adSpend" DESC`,
      [account.id, from, to]
    );
    return result.rows;
  });

  const performance: AdsProductPerformance[] = rows.map((r) => {
    const revenue = Number(r.revenue);
    const adSpend = Number(r.adSpend);
    const netProfit = Number(r.netProfit);
    return {
      productId: r.productId,
      title: r.title,
      revenue,
      adSpend,
      netProfit,
      roas: adSpend > 0 ? revenue / adSpend : null,
      recommendation: recommendAdsAction(netProfit, adSpend),
    };
  });

  return NextResponse.json(performance);
}
