import { NextRequest, NextResponse } from "next/server";
import { withScope } from "@/db/client";
import { resolveCurrentAccount } from "@/lib/current-account";
import { loadPricingRows } from "@/lib/pricing-data";
import { loadCompetitionData } from "@/lib/competition-data";
import { recommend, type Action } from "@/lib/recommend";

export const runtime = "nodejs";

/**
 * Precios y competencia en un solo lugar: por cada publicación, una
 * recomendación concreta (ver lib/recommend.ts) con el precio al que ir y lo
 * que cambia en la plata, más los cambios de precio de la competencia.
 *
 * ?target=0.2 margen objetivo · ?days=90 período para las tasas · ?ads=0 sin publicidad
 */
export async function GET(request: NextRequest) {
  const account = await resolveCurrentAccount();
  if (!account) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  const sp = request.nextUrl.searchParams;
  const target = Math.min(0.6, Math.max(0, Number(sp.get("target") ?? 0.2) || 0));
  const days = Math.min(365, Math.max(7, Math.round(Number(sp.get("days") ?? 90) || 90)));
  const includeAds = sp.get("ads") !== "0";

  const { pricing, comp } = await withScope({ accountId: account.id }, async (client) => ({
    pricing: await loadPricingRows(client, account.id, { target, days, includeAds }),
    comp: await loadCompetitionData(client, account.id, target, 7),
  }));

  const compRows = new Map(comp.available ? comp.rows.map((r: { id: string }) => [r.id, r]) : []);
  type CompRow = {
    status: string; priceToWin: number | null; winnerPrice: number | null; myPrice: number | null; position: number | null;
    competitorsCount: number; capturedAt: string; reading: { missing: string[]; have: string[] };
    competitors: { itemId: string; seller: string; price: number; previousPrice: number | null; changedAt: string | null; freeShipping: boolean | null; isWinner: boolean }[];
  };

  const items = pricing.map((p) => {
    const c = compRows.get(p.id) as CompRow | undefined;
    const ref = comp.available ? comp.references.get(p.id) ?? null : null;
    const rec = recommend({
      price: p.price,
      cost: p.cost,
      rates: p.rates,
      floorPrice: p.floorPrice,
      suggestedPrice: p.suggestedPrice,
      unitProfit: p.unitProfit,
      margin: p.margin,
      unitsSold: p.unitsSold,
      days,
      target,
      includeAds,
      catalog: c && c.status !== "unavailable"
        ? { status: c.status, priceToWin: c.priceToWin, winnerPrice: c.winnerPrice, missing: c.reading.missing, competitorPrices: c.competitors.map((x) => x.price) }
        : null,
      reference: ref ? { suggestedPrice: ref.suggestedPrice ?? null, lowestPrice: ref.lowestPrice ?? null } : null,
    });
    return {
      id: p.id,
      title: p.title,
      sku: p.sku,
      thumbnail: p.thumbnail,
      permalink: p.permalink,
      price: p.price,
      cost: p.cost,
      unitsSold: p.unitsSold,
      floorPrice: p.floorPrice,
      suggestedPrice: p.suggestedPrice,
      margin: p.margin,
      unitProfit: p.unitProfit,
      rates: p.rates,
      recommendation: rec,
      competition: c
        ? {
            status: c.status, priceToWin: c.priceToWin, winnerPrice: c.winnerPrice, position: c.position,
            competitorsCount: c.competitorsCount, capturedAt: c.capturedAt, missing: c.reading.missing, have: c.reading.have,
            competitors: c.competitors.slice(0, 8),
          }
        : null,
      reference: ref,
    };
  });

  const byAction = items.reduce<Partial<Record<Action, number>>>((a, i) => ((a[i.recommendation.action] = (a[i.recommendation.action] ?? 0) + 1), a), {});
  const losingMonthly = items
    .filter((i) => i.recommendation.action === "subir_pierde" && (i.recommendation.monthlyNow ?? 0) < 0)
    .reduce((a, i) => a + -(i.recommendation.monthlyNow ?? 0), 0);
  const raiseGain = items
    .filter((i) => ["subir_sin_perder", "subir_al_objetivo"].includes(i.recommendation.action))
    .reduce((a, i) => a + Math.max(0, (i.recommendation.monthlyAtTarget ?? 0) - (i.recommendation.monthlyNow ?? 0)), 0);

  return NextResponse.json({
    target,
    days,
    includeAds,
    competitionAvailable: comp.available,
    lastUpdated: comp.available ? comp.lastUpdated : null,
    summary: {
      byAction,
      losingMonthly,
      raiseGain,
      catalogCount: comp.available ? comp.counts.total : 0,
      notCatalogCount: comp.available ? comp.notCatalogIds.size : 0,
    },
    items,
    changes: comp.available ? comp.changes : [],
  });
}
