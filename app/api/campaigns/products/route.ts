import { NextRequest, NextResponse } from "next/server";
import { withScope } from "@/db/client";
import { resolveCurrentAccount } from "@/lib/current-account";
import { revenueStatusFilter } from "@/lib/order-status";
import { attributedAdsMetrics, type AttributedRecommendation } from "@/lib/ads-recommendation";
import { getProductAdsReport, AdsTimeBudgetError, type AdsItemMetrics } from "@/mcp/tools";

export const runtime = "nodejs";
export const maxDuration = 60;

export interface AdsProductRow {
  productId: string;
  title: string;
  campaignId: string | null;
  spend: number;
  clicks: number;
  prints: number;
  /** Clics ÷ impresiones. */
  ctr: number | null;
  /** Inversión ÷ clics. */
  cpc: number | null;
  /** Ventas atribuidas al anuncio (directas + indirectas). */
  adRevenue: number;
  adUnits: number;
  organicUnits: number;
  /** Unidades por publicidad ÷ clics. */
  cvr: number | null;
  /** Qué parte de las unidades vendidas vino de la publicidad. */
  adShare: number | null;
  roas: number | null;
  acos: number | null;
  breakevenAcos: number | null;
  adsProfit: number | null;
  recommendation: AttributedRecommendation;
}

export interface AdsCampaignRow {
  id: string;
  name: string;
  status: string;
  budget: number;
  spend: number;
  adRevenue: number;
  adUnits: number;
  roas: number | null;
  acos: number | null;
  products: number;
}

export interface AdsReportResponse {
  available: boolean;
  from: string | null;
  to: string | null;
  clamped: boolean;
  error?: string;
  totals: {
    spend: number;
    adRevenue: number;
    adUnits: number;
    organicUnits: number;
    clicks: number;
    prints: number;
    roas: number | null;
    acos: number | null;
    /** Inversión ÷ facturación TOTAL de la cuenta en el rango (orgánica + Ads). */
    tacos: number | null;
    adShare: number | null;
    cpc: number | null;
    ctr: number | null;
    cvr: number | null;
  } | null;
  campaigns: AdsCampaignRow[];
  products: AdsProductRow[];
}

const ratio = (a: number, b: number) => (b > 0 ? a / b : null);

/**
 * Rendimiento real de Mercado Ads: lo que se vendió GRACIAS a cada anuncio
 * (según Mercado Ads), no toda la facturación del producto dividida por lo
 * gastado — eso mezclaba ventas orgánicas e inflaba el ROAS.
 *
 * Por publicación: inversión, ventas y unidades atribuidas, ROAS, ACOS,
 * clics, CTR, CPC, conversión, qué parte de sus ventas vino de Ads, y —con el
 * margen del producto en el mismo período— el ACOS de equilibrio y cuánto
 * dejaron de verdad las ventas por publicidad.
 *
 * Solo lee (Mercado Ads + ventas ya guardadas): no toca el cálculo de
 * ganancia. Mercado Ads guarda ~90 días: un rango más viejo se recorta y la
 * respuesta lo avisa.
 */
export async function GET(request: NextRequest) {
  const account = await resolveCurrentAccount();
  if (!account) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const { searchParams } = request.nextUrl;
  const today = new Date().toISOString().slice(0, 10);
  const from = searchParams.get("from") ?? today;
  const to = searchParams.get("to") ?? today;

  let report;
  try {
    report = await getProductAdsReport(account.id, from, to);
  } catch (err) {
    const message = err instanceof AdsTimeBudgetError
      ? "Mercado Ads tardó demasiado en responder. Probá de nuevo en un momento o con un rango más corto."
      : "No se pudo leer el reporte de Mercado Ads. Probá de nuevo en un momento.";
    console.error("Reporte de Mercado Ads:", (err as Error).message);
    const empty: AdsReportResponse = { available: true, from: null, to: null, clamped: false, error: message, totals: null, campaigns: [], products: [] };
    return NextResponse.json(empty, { status: 502 });
  }

  if (!report.available || !report.from || !report.to) {
    const none: AdsReportResponse = { available: report.available, from: report.from, to: report.to, clamped: report.clamped, totals: null, campaigns: [], products: [] };
    return NextResponse.json(none);
  }
  const range = { from: report.from, to: report.to };

  const ids = report.items.map((i) => i.itemId);
  const db = await withScope({ accountId: account.id }, async (client) => {
    // Margen antes de Ads de cada producto en el mismo rango: (ganancia +
    // publicidad repartida) ÷ facturación. Si alguna venta no tiene costo, no
    // se informa (no se puede saber si el anuncio conviene sin el costo).
    const perProduct = await client.query<{
      productId: string; title: string | null; revenue: number; netBeforeAds: number | null; missingCost: string | number;
    }>(
      `SELECT p.id as "productId", p.title,
              COALESCE(s.revenue, 0) as revenue, s.net_before_ads as "netBeforeAds", COALESCE(s.missing_cost, 0) as "missingCost"
         FROM unnest($2::text[]) AS ids(id)
         LEFT JOIN products p ON p.account_id = $1 AND p.id = ids.id
         LEFT JOIN (
           SELECT oi.product_id,
                  SUM(oi.unit_price * oi.quantity) as revenue,
                  SUM(oi.net_profit + oi.ads_cost_allocated) as net_before_ads,
                  COUNT(*) FILTER (WHERE oi.net_profit IS NULL) as missing_cost
             FROM order_items oi JOIN orders o ON o.account_id = oi.account_id AND o.id = oi.order_id
            WHERE oi.account_id = $1 AND oi.product_id = ANY($2::text[])
              AND o.date_created::date BETWEEN $3::date AND $4::date
              AND ${revenueStatusFilter()}
            GROUP BY oi.product_id
         ) s ON s.product_id = ids.id`,
      [account.id, ids, range.from, range.to]
    );
    const accountRevenue = await client.query<{ revenue: number }>(
      `SELECT COALESCE(SUM(oi.unit_price * oi.quantity), 0) as revenue
         FROM order_items oi JOIN orders o ON o.account_id = oi.account_id AND o.id = oi.order_id
        WHERE oi.account_id = $1 AND o.date_created::date BETWEEN $2::date AND $3::date AND ${revenueStatusFilter()}`,
      [account.id, range.from, range.to]
    );
    return { perProduct: perProduct.rows, accountRevenue: Number(accountRevenue.rows[0]?.revenue ?? 0) };
  });

  const byId = new Map(db.perProduct.map((r) => [r.productId ?? "", r]));
  const products: AdsProductRow[] = report.items
    .map((i: AdsItemMetrics) => {
      const row = byId.get(i.itemId);
      const revenue = Number(row?.revenue ?? 0);
      const marginBeforeAds =
        row && Number(row.missingCost) === 0 && revenue > 0 && row.netBeforeAds !== null
          ? Number(row.netBeforeAds) / revenue
          : null;
      return {
        productId: i.itemId,
        title: row?.title ?? i.itemId,
        campaignId: i.campaignId,
        spend: i.cost,
        clicks: i.clicks,
        prints: i.prints,
        ctr: ratio(i.clicks, i.prints),
        cpc: ratio(i.cost, i.clicks),
        adRevenue: i.totalAmount,
        adUnits: i.units,
        organicUnits: i.organicUnits,
        cvr: ratio(i.units, i.clicks),
        adShare: ratio(i.units, i.units + i.organicUnits),
        ...attributedAdsMetrics({ spend: i.cost, adRevenue: i.totalAmount, marginBeforeAds }),
      };
    })
    .sort((a, b) => b.spend - a.spend);

  const sum = (pick: (p: AdsItemMetrics) => number) => report.items.reduce((s, i) => s + pick(i), 0);
  const spend = sum((i) => i.cost);
  const adRevenue = sum((i) => i.totalAmount);
  const adUnits = sum((i) => i.units);
  const organicUnits = sum((i) => i.organicUnits);
  const clicks = sum((i) => i.clicks);
  const prints = sum((i) => i.prints);

  const campaignRows = new Map<string, AdsCampaignRow>();
  for (const c of report.campaigns) {
    campaignRows.set(c.id, { id: c.id, name: c.name, status: c.status, budget: c.budget, spend: 0, adRevenue: 0, adUnits: 0, roas: null, acos: null, products: 0 });
  }
  for (const i of report.items) {
    if (!i.campaignId) continue;
    const row = campaignRows.get(i.campaignId) ?? {
      id: i.campaignId, name: i.campaignId, status: "unknown", budget: 0, spend: 0, adRevenue: 0, adUnits: 0, roas: null, acos: null, products: 0,
    };
    row.spend += i.cost;
    row.adRevenue += i.totalAmount;
    row.adUnits += i.units;
    row.products += 1;
    campaignRows.set(i.campaignId, row);
  }
  const campaigns = [...campaignRows.values()]
    .map((c) => ({ ...c, roas: ratio(c.adRevenue, c.spend), acos: ratio(c.spend, c.adRevenue) }))
    .sort((a, b) => b.spend - a.spend);

  const body: AdsReportResponse = {
    available: true,
    from: range.from,
    to: range.to,
    clamped: report.clamped,
    totals: {
      spend, adRevenue, adUnits, organicUnits, clicks, prints,
      roas: ratio(adRevenue, spend),
      acos: ratio(spend, adRevenue),
      tacos: ratio(spend, db.accountRevenue),
      adShare: ratio(adUnits, adUnits + organicUnits),
      cpc: ratio(spend, clicks),
      ctr: ratio(clicks, prints),
      cvr: ratio(adUnits, clicks),
    },
    campaigns,
    products,
  };
  return NextResponse.json(body);
}
