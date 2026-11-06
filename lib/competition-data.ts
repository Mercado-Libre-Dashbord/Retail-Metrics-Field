import type { QueryExecutor } from "@/db/client";
import { hasColumn } from "@/db/schema-capabilities";
import { loadPricingRows } from "@/lib/pricing-data";
import { priceChanges, readCompetition, type Boost } from "@/lib/competition";
import { competitionAvailable } from "@/sync/competition";
import type { PriceReference } from "@/mcp/tools";

/**
 * La última foto de competencia de cada publicación, cruzada con su margen,
 * más los cambios de precio de la competencia en los últimos `days` días.
 * La usan /api/competition y /api/prices/overview.
 */
export async function loadCompetitionData(client: QueryExecutor, accountId: string, target: number, days: number) {
  const account = { id: accountId };
  const result = await (async () => {
    if (!(await competitionAvailable(client))) return { available: false as const };
    const pricing = await loadPricingRows(client, account.id, { target, days: 90, includeAds: true });
    const byId = new Map(pricing.map((r) => [r.id, r]));

    const snaps = await client.query(
      `SELECT DISTINCT ON (product_id) product_id, captured_at, catalog_product_id, status, my_price, price_to_win,
              winner_item_id, winner_price, visit_share, reasons, boosts,
              ${(await hasColumn(client, "competition_snapshots", "reference")) ? "reference" : "NULL::jsonb AS reference"}
         FROM competition_snapshots WHERE account_id = $1
        ORDER BY product_id, captured_at DESC`,
      [account.id]
    );
    const history = await client.query(
      `SELECT catalog_product_id, item_id, seller_id, seller_nickname, price, free_shipping, captured_at
         FROM competitor_prices
        WHERE account_id = $1
          AND (captured_at > now() - ($2::int * interval '1 day')
               OR id IN (SELECT DISTINCT ON (item_id) id FROM competitor_prices WHERE account_id = $1 ORDER BY item_id, captured_at DESC))
        ORDER BY captured_at`,
      [account.id, days]
    );
    // Un punto anterior a la ventana por competidor, para que el primer cambio
    // dentro de la ventana tenga contra qué compararse.
    const before = await client.query(
      `SELECT DISTINCT ON (item_id) catalog_product_id, item_id, seller_id, seller_nickname, price, free_shipping, captured_at
         FROM competitor_prices
        WHERE account_id = $1 AND captured_at <= now() - ($2::int * interval '1 day')
        ORDER BY item_id, captured_at DESC`,
      [account.id, days]
    );
    return { available: true as const, pricing: byId, snaps: snaps.rows, history: [...before.rows, ...history.rows] };
  })();

  if (!result.available) {
    return { available: false as const };
  }

  type H = { catalog_product_id: string; item_id: string; seller_id: string | null; seller_nickname: string | null; price: number; free_shipping: boolean | null; captured_at: string | Date };
  const hist = (result.history as H[]).map((h) => ({ ...h, price: Number(h.price), at: new Date(h.captured_at).toISOString() }));
  const myIds = new Set(result.snaps.map((s: Record<string, unknown>) => String(s.product_id)));
  const productByCatalog = new Map<string, { id: string; title: string }>();

  const rows = result.snaps
    .filter((s: Record<string, unknown>) => s.status !== "not_catalog")
    .map((s: Record<string, unknown>) => {
      const id = String(s.product_id);
      const pr = result.pricing.get(id);
      const catalog = (s.catalog_product_id as string | null) ?? null;
      if (catalog && pr) productByCatalog.set(catalog, { id, title: pr.title });
      const snap = {
        status: String(s.status),
        myPrice: s.my_price === null ? null : Number(s.my_price),
        priceToWin: s.price_to_win === null ? null : Number(s.price_to_win),
        winnerItemId: (s.winner_item_id as string | null) ?? null,
        winnerPrice: s.winner_price === null ? null : Number(s.winner_price),
        reasons: (s.reasons as string[]) ?? [],
        boosts: ((s.boosts as Boost[]) ?? []).filter((b) => b && b.id),
      };
      const reading = pr
        ? readCompetition(snap, pr.cost, pr.rates, target)
        : readCompetition(snap, null, { commission: 0, iva: 0, tax: 0, ads: 0, shippingPerUnit: 0, estimated: true }, target);

      // Competidores del catálogo: el último precio de cada uno y el anterior.
      const byItem = new Map<string, typeof hist>();
      for (const h of hist) {
        if (h.catalog_product_id !== catalog || myIds.has(h.item_id)) continue;
        const l = byItem.get(h.item_id) ?? [];
        l.push(h);
        byItem.set(h.item_id, l);
      }
      const competitors = [...byItem.values()]
        .map((l) => {
          l.sort((a, b) => a.at.localeCompare(b.at));
          const cur = l[l.length - 1];
          const prev = l.length > 1 ? l[l.length - 2] : null;
          return {
            itemId: cur.item_id,
            seller: cur.seller_nickname ?? l.find((x) => x.seller_nickname)?.seller_nickname ?? cur.seller_id ?? "—",
            price: cur.price,
            previousPrice: prev ? prev.price : null,
            changedAt: prev ? cur.at : null,
            freeShipping: cur.free_shipping,
            isWinner: cur.item_id === snap.winnerItemId,
          };
        })
        .sort((a, b) => a.price - b.price);
      const myPrice = snap.myPrice ?? pr?.price ?? null;
      const cheaper = myPrice === null ? 0 : competitors.filter((c) => c.price < myPrice).length;

      return {
        id,
        title: pr?.title ?? id,
        thumbnail: pr?.thumbnail ?? null,
        permalink: pr?.permalink ?? null,
        capturedAt: new Date(s.captured_at as string).toISOString(),
        catalogProductId: catalog,
        visitShare: (s.visit_share as string | null) ?? null,
        cost: pr?.cost ?? null,
        floorPrice: pr?.floorPrice ?? null,
        suggestedPrice: pr?.suggestedPrice ?? null,
        unitsSold: pr?.unitsSold ?? 0,
        ...snap,
        myPrice,
        reading,
        competitors,
        position: competitors.length > 0 && myPrice !== null ? cheaper + 1 : null,
        competitorsCount: competitors.length,
      };
    });

  const changes = priceChanges(
    hist.filter((h) => !myIds.has(h.item_id)).map((h) => ({ itemId: h.item_id, sellerNickname: h.seller_nickname, price: h.price, capturedAt: h.at, catalog: h.catalog_product_id }))
  )
    .filter((c) => Date.parse(c.at) > Date.now() - days * 86400000)
    .map((c) => {
      const catalog = hist.find((h) => h.item_id === c.itemId)?.catalog_product_id ?? null;
      const mine = catalog ? productByCatalog.get(catalog) : undefined;
      const row = mine ? rows.find((r: { id: string }) => r.id === mine.id) : undefined;
      return {
        ...c,
        productId: mine?.id ?? null,
        productTitle: mine?.title ?? catalog,
        myPrice: row?.myPrice ?? null,
        nowCheaperThanMe: row?.myPrice != null ? c.to < row.myPrice : null,
      };
    })
    .slice(0, 100);

  const counts = {
    total: rows.length,
    ganando: rows.filter((r: { reading: { cause: string } }) => r.reading.cause === "ganas").length,
    perdiendoPorPrecio: rows.filter((r: { reading: { cause: string } }) => r.reading.cause === "precio").length,
    perdiendoPorOtraCosa: rows.filter((r: { reading: { cause: string } }) => r.reading.cause === "no_precio").length,
    notCatalog: result.snaps.filter((s: Record<string, unknown>) => s.status === "not_catalog").length,
    cambios: changes.length,
  };
  const lastUpdated = rows.reduce<string | null>((a: string | null, r: { capturedAt: string }) => (!a || r.capturedAt > a ? r.capturedAt : a), null);

  const references = new Map<string, PriceReference>(
    result.snaps
      .filter((s: Record<string, unknown>) => s.reference)
      .map((s: Record<string, unknown>) => [String(s.product_id), s.reference as PriceReference])
  );
  const notCatalogIds = new Set(result.snaps.filter((s: Record<string, unknown>) => s.status === "not_catalog").map((s: Record<string, unknown>) => String(s.product_id)));
  return { available: true as const, lastUpdated, counts, rows, changes, references, notCatalogIds, pricing: result.pricing };
}
