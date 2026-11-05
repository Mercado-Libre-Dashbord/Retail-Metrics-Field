/**
 * Lectura de la competencia en catálogo: por qué ganás o perdés, si te
 * conviene igualar el precio para ganar, y qué cambió en los precios de los
 * demás.
 *
 * Mercado Libre manda los motivos y "boosts" como códigos en inglés que no
 * documenta del todo; se traducen por palabras clave, y un código desconocido
 * se muestra tal cual en vez de perderse.
 */
import { marginAt, type PricingRates } from "./pricing";

export interface Boost {
  id: string;
  /** boosted = ya lo tenés · opportunity = te falta y suma · not_apply = no aplica. */
  status: string;
}

export interface CompetitionSnapshot {
  status: string;
  myPrice: number | null;
  priceToWin: number | null;
  winnerItemId: string | null;
  winnerPrice: number | null;
  reasons: string[];
  boosts: Boost[];
}

const TERMS: [RegExp, string][] = [
  [/full|fulfillment/i, "Mercado Envíos Full"],
  [/same_day|same-day/i, "envío en el día"],
  [/next_day|fast|flex/i, "envío rápido"],
  [/free_shipping|shipping_not_free|shipping/i, "envío gratis"],
  [/installment|cuota/i, "cuotas sin interés"],
  [/reputation|trusted|thermometer/i, "reputación"],
  [/manufacturing|handling|delivery_time|lead_time/i, "tiempo de entrega"],
  [/stock|quantity/i, "stock"],
  [/price/i, "precio"],
];

export function describeCode(code: string): string {
  for (const [re, label] of TERMS) if (re.test(code)) return label;
  return code.replace(/_/g, " ");
}

export type LosingCause = "precio" | "no_precio" | "ganas" | "sin_dato";

export interface CompetitionReading {
  cause: LosingCause;
  /** Cuánto más caro estás que el precio para ganar (si perdés por precio). */
  overBy: number | null;
  overByPct: number | null;
  /** Lo que ML dice que te falta (boosts en "opportunity" y motivos), traducido. */
  missing: string[];
  /** Lo que ya tenés a favor (boosts en "boosted"). */
  have: string[];
  /** Margen si bajás al precio para ganar (null sin costo o sin precio para ganar). */
  marginAtWin: number | null;
  /** Ganancia por unidad a ese precio. */
  profitAtWin: number | null;
  /** Veredicto para la pantalla. */
  verdict: "igualar_conviene" | "igualar_bajo_objetivo" | "igualar_pierde" | "no_hace_falta" | "sin_costo" | "sin_dato";
}

function uniq(list: string[]): string[] {
  return [...new Set(list)];
}

export function readCompetition(
  snap: CompetitionSnapshot,
  cost: number | null,
  rates: PricingRates,
  targetMargin: number,
  includeAds = true
): CompetitionReading {
  const winning = snap.status === "winning" || snap.status === "sharing_first_place";
  const missing = uniq([
    ...snap.boosts.filter((b) => b.status === "opportunity").map((b) => describeCode(b.id)),
    ...snap.reasons.map(describeCode),
  ]).filter((m) => m !== "precio");
  const have = uniq(snap.boosts.filter((b) => b.status === "boosted").map((b) => describeCode(b.id)));

  if (snap.status === "not_catalog" || snap.status === "unavailable") {
    return { cause: "sin_dato", overBy: null, overByPct: null, missing: [], have: [], marginAtWin: null, profitAtWin: null, verdict: "sin_dato" };
  }

  const my = snap.myPrice;
  const win = snap.priceToWin;
  const overBy = !winning && my !== null && win !== null && my > win ? my - win : null;
  const cause: LosingCause = winning ? "ganas" : overBy !== null ? "precio" : win === null && my === null ? "sin_dato" : "no_precio";

  let marginAtWin: number | null = null;
  let profitAtWin: number | null = null;
  if (cost !== null && win !== null && win > 0) {
    marginAtWin = marginAt(win, cost, rates, includeAds);
    profitAtWin = marginAtWin === null ? null : marginAtWin * win;
  }

  let verdict: CompetitionReading["verdict"];
  if (winning || cause === "no_precio") verdict = "no_hace_falta";
  else if (cost === null) verdict = "sin_costo";
  else if (marginAtWin === null) verdict = "sin_dato";
  else if (marginAtWin < 0) verdict = "igualar_pierde";
  else if (marginAtWin < targetMargin - 0.005) verdict = "igualar_bajo_objetivo";
  else verdict = "igualar_conviene";

  return {
    cause,
    overBy,
    overByPct: overBy !== null && my ? overBy / my : null,
    missing,
    have,
    marginAtWin,
    profitAtWin,
    verdict,
  };
}

export interface PricePoint {
  itemId: string;
  sellerNickname: string | null;
  price: number;
  capturedAt: string;
}

export interface PriceChange {
  itemId: string;
  sellerNickname: string | null;
  from: number;
  to: number;
  changePct: number;
  at: string;
}

/**
 * Cambios de precio de la competencia a partir del historial (una fila por
 * precio distinto). Devuelve el más reciente primero.
 */
export function priceChanges(history: PricePoint[]): PriceChange[] {
  const byItem = new Map<string, PricePoint[]>();
  for (const p of history) {
    const list = byItem.get(p.itemId) ?? [];
    list.push(p);
    byItem.set(p.itemId, list);
  }
  const changes: PriceChange[] = [];
  for (const list of byItem.values()) {
    list.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1];
      const cur = list[i];
      if (Math.abs(cur.price - prev.price) < 0.5) continue;
      changes.push({
        itemId: cur.itemId,
        sellerNickname: cur.sellerNickname ?? prev.sellerNickname,
        from: prev.price,
        to: cur.price,
        changePct: prev.price > 0 ? (cur.price - prev.price) / prev.price : 0,
        at: cur.capturedAt,
      });
    }
  }
  return changes.sort((a, b) => b.at.localeCompare(a.at));
}
