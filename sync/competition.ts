import type { QueryExecutor } from "@/db/client";
import { hasColumn } from "@/db/schema-capabilities";
import { getCatalogCompetitors, getPriceReference, getPriceToWin, getSellerNicknames, type PriceReference } from "@/mcp/tools";

/**
 * Actualiza la foto de la competencia de las publicaciones de catálogo.
 *
 * Por cada publicación: el "precio para ganar" (quién gana, a qué precio, por
 * qué) y el precio de cada competidor del catálogo. Del competidor solo se
 * guarda una fila nueva cuando su precio cambió: así competitor_prices es el
 * historial de cambios de precio de los demás.
 *
 * Además, para todas (sean o no de catálogo), la referencia de precios de ML:
 * el precio sugerido y el más bajo entre publicaciones similares.
 *
 * Las que no son de catálogo se marcan 'not_catalog' y se vuelven a mirar
 * cada NOT_CATALOG_RECHECK_HOURS (la referencia cambia más despacio y una
 * publicación puede pasar a catálogo).
 *
 * Corre con presupuesto de tiempo: lo que no entra queda para la próxima
 * llamada, que arranca por las publicaciones con la foto más vieja.
 */
export const NOT_CATALOG_RECHECK_HOURS = 24;
/** Una foto más nueva que esto no se vuelve a pedir (ML limita los pedidos). */
export const FRESH_MINUTES = 10;
const CONCURRENCY = 4;

export async function competitionAvailable(client: QueryExecutor): Promise<boolean> {
  return hasColumn(client, "competition_snapshots", "price_to_win");
}

export async function refreshCompetition(
  client: QueryExecutor,
  accountId: string,
  opts: { productIds?: string[]; timeBudgetMs?: number; force?: boolean } = {}
): Promise<{ refreshed: number; remaining: number }> {
  if (!(await competitionAvailable(client))) return { refreshed: 0, remaining: 0 };
  const deadline = Date.now() + (opts.timeBudgetMs ?? 35_000);

  // Candidatas: publicaciones activas con precio, primero las que nunca se
  // miraron y después las de foto más vieja. Se saltean las frescas y las que
  // se sabe que no son de catálogo (hasta que toque volver a mirarlas).
  const candidates = await client.query<{ id: string; price: number }>(
    `SELECT p.id, p.current_price AS price
       FROM products p
       LEFT JOIN LATERAL (
         SELECT status, captured_at FROM competition_snapshots s
          WHERE s.account_id = p.account_id AND s.product_id = p.id
          ORDER BY captured_at DESC LIMIT 1
       ) last ON true
      WHERE p.account_id = $1 AND COALESCE(p.current_price, 0) > 0
        AND ($2::text[] IS NULL OR p.id = ANY($2::text[]))
        AND ($3::boolean OR last.captured_at IS NULL
             OR (last.status <> 'not_catalog' AND last.captured_at < now() - ($4::int * interval '1 minute'))
             OR (last.status = 'not_catalog' AND last.captured_at < now() - ($5::int * interval '1 hour')))
      ORDER BY last.captured_at ASC NULLS FIRST`,
    [accountId, opts.productIds ?? null, opts.force === true, FRESH_MINUTES, NOT_CATALOG_RECHECK_HOURS]
  );

  const hasReference = await hasColumn(client, "competition_snapshots", "reference");
  const queue = candidates.rows;
  let refreshed = 0;
  while (queue.length > 0 && Date.now() < deadline) {
    const chunk = queue.splice(0, CONCURRENCY);
    const [results, references] = await Promise.all([
      Promise.all(chunk.map((p) => getPriceToWin(accountId, p.id).catch(() => null))),
      hasReference
        ? Promise.all(chunk.map((p) => getPriceReference(accountId, p.id).catch((): PriceReference => ({ available: false }))))
        : Promise.resolve(chunk.map((): PriceReference => ({ available: false }))),
    ]);
    // Mercado Libre limitó los pedidos: se corta acá y lo que falta sigue en
    // la próxima actualización, sin guardar una foto vacía.
    if (results.some((r) => r && !r.available && r.reason?.includes("limitó"))) {
      queue.unshift(...chunk);
      break;
    }
    for (let i = 0; i < chunk.length; i++) {
      const p = chunk[i];
      const r = results[i];
      if (!r) continue;
      const status = r.available ? (r.status ?? "listed") : r.reason?.includes("catálogo") ? "not_catalog" : "unavailable";
      const ref = references[i];
      await client.query(
        `INSERT INTO competition_snapshots
           (account_id, product_id, catalog_product_id, status, my_price, price_to_win, winner_item_id, winner_price, visit_share, reasons, boosts${hasReference ? ", reference" : ""})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb${hasReference ? ", $12::jsonb" : ""})`,
        [
          accountId, p.id, r.catalogProductId ?? null, status, r.currentPrice ?? Number(p.price),
          r.priceToWin ?? null, r.winnerItemId ?? null, r.winnerPrice ?? null, r.visitShare ?? null,
          r.reasons ?? [], JSON.stringify(r.boosts ?? []),
          ...(hasReference ? [ref.available ? JSON.stringify(ref) : null] : []),
        ]
      );
      refreshed += 1;
      if (r.available && r.catalogProductId) await saveCompetitorPrices(client, accountId, r.catalogProductId);
    }
  }
  return { refreshed, remaining: queue.length };
}

async function saveCompetitorPrices(client: QueryExecutor, accountId: string, catalogProductId: string) {
  const competitors = await getCatalogCompetitors(accountId, catalogProductId).catch(() => []);
  if (competitors.length === 0) return;
  const last = await client.query<{ item_id: string; price: number; seller_nickname: string | null }>(
    `SELECT DISTINCT ON (item_id) item_id, price, seller_nickname
       FROM competitor_prices WHERE account_id = $1 AND catalog_product_id = $2
      ORDER BY item_id, captured_at DESC`,
    [accountId, catalogProductId]
  );
  const known = new Map(last.rows.map((r) => [r.item_id, r]));
  const changed = competitors.filter((c) => {
    const prev = known.get(c.itemId);
    return !prev || Math.abs(Number(prev.price) - c.price) >= 0.5;
  });
  if (changed.length === 0) return;
  const needNick = changed.filter((c) => c.sellerId && !known.get(c.itemId)?.seller_nickname).map((c) => c.sellerId!);
  const nicks = needNick.length > 0 ? await getSellerNicknames(accountId, needNick).catch(() => new Map<string, string>()) : new Map<string, string>();
  for (const c of changed) {
    await client.query(
      `INSERT INTO competitor_prices (account_id, catalog_product_id, item_id, seller_id, seller_nickname, price, free_shipping, listing_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        accountId, catalogProductId, c.itemId, c.sellerId,
        (c.sellerId && nicks.get(c.sellerId)) ?? known.get(c.itemId)?.seller_nickname ?? null,
        c.price, c.freeShipping, c.listingType,
      ]
    );
  }
}
