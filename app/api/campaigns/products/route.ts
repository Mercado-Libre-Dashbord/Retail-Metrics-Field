import { NextRequest, NextResponse } from "next/server";
import { withScope } from "@/db/client";
import { resolveCurrentAccount } from "@/lib/current-account";
import { revenueStatusFilter } from "@/lib/order-status";
import { recommendAdsAction, acosMetrics, type AdsRecommendation } from "@/lib/ads-recommendation";

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
  /** Ver acosMetrics en lib/ads-recommendation.ts. */
  acos: number | null;
  breakevenAcos: number | null;
  maxAdSpend: number;
  /** Hay ventas de esta publicación sin costo cargado: su ganancia (y por lo
   * tanto la recomendación) no es confiable hasta cargarlo. */
  missingCost: boolean;
  recommendation: AdsRecommendation;
}

/**
 * Rendimiento real de Ads por publicación, para decidir a cuál seguir
 * pagando, a cuál sacarle presupuesto, y a cuál ponerle más plata — no solo
 * mirar el total de la cuenta.
 *
 * Ganancia neta = ganancia de sus ventas antes de Ads − todo lo que gastó en
 * Ads en el período (no solo lo repartido entre sus ventas).
 *
 * Depende de que ads_spend tenga product_id real: eso solo existe para los
 * últimos ~90 días, el límite que da la API de Mercado Ads para el gasto por
 * publicación (ver getAdsSpend en mcp/tools.ts). Para un período más viejo,
 * esta lista sale vacía — no es un error, ese dato ya no existe en ML.
 */
export async function GET(request: NextRequest) {
  const account = await resolveCurrentAccount();
  if (!account) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const { searchParams } = request.nextUrl;
  const from = searchParams.get("from") ?? "1970-01-01";
  const to = searchParams.get("to") ?? "9999-12-31";

  const rows = await withScope({ accountId: account.id }, async (client) => {
    // El gasto sale de ads_spend (lo que Mercado Ads dice que gastó cada
    // publicación), no de lo repartido entre sus ventas: una publicación que
    // gasta en Ads y no vende nada no tiene ventas donde repartirlo, y antes
    // directamente no aparecía acá — justo la que más urge pausar.
    //
    // Las ventas se cuentan solo desde el primer día con dato de Ads: ML da
    // ~90 días de gasto por publicación; comparar ese gasto contra la
    // facturación de todo el año daría un ACOS falsamente bajo.
    const result = await client.query<{
      productId: string; title: string; revenue: number; adSpend: number; netBeforeAds: number; missingCost: number;
    }>(
      `WITH spend AS (
         SELECT product_id, SUM(amount) as spend, MIN(date) as first_day
           FROM ads_spend
          WHERE account_id = $1 AND channel = 'mercado_ads' AND product_id IS NOT NULL
            AND date BETWEEN $2::date AND $3::date
          GROUP BY product_id
         HAVING SUM(amount) > 0
       ),
       sales AS (
         SELECT oi.product_id,
                SUM(oi.unit_price * oi.quantity) as revenue,
                SUM(oi.net_profit + oi.ads_cost_allocated) as net_before_ads,
                COUNT(*) FILTER (WHERE oi.net_profit IS NULL) as missing_cost
           FROM order_items oi
           JOIN orders o ON o.account_id = oi.account_id AND o.id = oi.order_id
           JOIN spend s ON s.product_id = oi.product_id
          WHERE oi.account_id = $1
            AND o.date_created::date BETWEEN s.first_day AND $3::date
            AND ${revenueStatusFilter()}
          GROUP BY oi.product_id
       )
       SELECT s.product_id as "productId", COALESCE(p.title, s.product_id) as title,
              COALESCE(sa.revenue, 0) as revenue, s.spend as "adSpend",
              COALESCE(sa.net_before_ads, 0) as "netBeforeAds",
              COALESCE(sa.missing_cost, 0) as "missingCost"
         FROM spend s
         LEFT JOIN sales sa ON sa.product_id = s.product_id
         LEFT JOIN products p ON p.account_id = $1 AND p.id = s.product_id
        ORDER BY s.spend DESC`,
      [account.id, from, to]
    );
    return result.rows;
  });

  const performance: AdsProductPerformance[] = rows.map((r) => {
    const revenue = Number(r.revenue);
    const adSpend = Number(r.adSpend);
    const netProfit = Number(r.netBeforeAds) - adSpend;
    return {
      productId: r.productId,
      title: r.title,
      revenue,
      adSpend,
      netProfit,
      roas: adSpend > 0 ? revenue / adSpend : null,
      ...acosMetrics(revenue, netProfit, adSpend),
      missingCost: Number(r.missingCost) > 0,
      recommendation: recommendAdsAction(netProfit, adSpend),
    };
  });

  return NextResponse.json(performance);
}
