/**
 * Asesor de publicidad: qué hacer con cada publicación en Mercado Ads y con
 * cuánta plata por día, a partir de lo que ya sabemos de ella (margen real
 * antes de publicidad y lo que el anuncio vendió de verdad).
 *
 * La idea, en una línea: el margen de un producto es lo máximo que se puede
 * gastar en publicidad por cada $100 vendidos sin perder plata (el ACOS de
 * equilibrio). Apuntamos a gastar como mucho el 60% de ese margen, así cada
 * venta por publicidad sigue dejando ganancia.
 *
 * Es una guía con reglas fijas, no una predicción: subir el presupuesto no
 * garantiza vender en proporción. Por eso los cambios son graduales (como
 * mucho +50% de una vez) y siempre se sugiere volver a mirar en una semana.
 */

/** Qué parte del margen se está dispuesto a gastar en publicidad. */
export const TARGET_SHARE_OF_MARGIN = 0.6;
/** El aumento máximo sugerido de una sola vez. */
const MAX_STEP_UP = 1.5;
/** Un ACOS por encima de esto (veces el equilibrio) ya no se corrige bajando: se pausa. */
const PAUSE_ABOVE = 1.5;
/** Margen mínimo para sugerir empezar a publicitar un producto. */
const MIN_MARGIN_TO_START = 0.15;
/** Unidades mínimas vendidas en el período para sugerir publicitarlo. */
const MIN_UNITS_TO_START = 3;

export type AdviceAction = "pausar" | "bajar" | "mantener" | "subir" | "probar" | "revisar_precio" | "sin_costo";

export const ACTION_LABEL: Record<AdviceAction, string> = {
  pausar: "Pausar",
  bajar: "Bajar",
  mantener: "Mantener",
  subir: "Invertir más",
  probar: "Probar con publicidad",
  revisar_precio: "Revisar precio",
  sin_costo: "Falta el costo",
};

export interface AdvisedProduct {
  productId: string;
  title: string;
  action: AdviceAction;
  /** Margen antes de publicidad = ACOS de equilibrio. Null sin costo. */
  breakevenAcos: number | null;
  /** El ACOS al que apuntamos: 60% del de equilibrio. */
  targetAcos: number | null;
  acos: number | null;
  /** Gasto promedio por día en el período. */
  currentDaily: number;
  /** Tope diario sugerido (0 = pausar). Null cuando no hay base para sugerir. */
  suggestedDaily: number | null;
  /** Lo que dejaron las ventas por publicidad después de pagarla, en el período. */
  adsProfit: number | null;
  /** Una frase con el porqué, en palabras del vendedor. */
  reason: string;
}

export interface AdInput {
  productId: string;
  title: string;
  spend: number;
  adRevenue: number;
  adUnits: number;
  breakevenAcos: number | null;
}

export interface CandidateInput {
  productId: string;
  title: string;
  units: number;
  revenue: number;
  /** (ganancia + publicidad) ÷ facturación; null si falta costo. */
  marginBeforeAds: number | null;
}

const money = (n: number) => `$${Math.round(n).toLocaleString("es-AR")}`;
const pct = (n: number) => `${(n * 100).toLocaleString("es-AR", { maximumFractionDigits: 1 })}%`;
/** Redondeo a $100, que es como se carga un presupuesto. */
const round100 = (n: number) => Math.max(0, Math.round(n / 100) * 100);

export function daysBetween(from: string, to: string): number {
  const a = new Date(`${from}T00:00:00Z`).getTime();
  const b = new Date(`${to}T00:00:00Z`).getTime();
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? Math.round((b - a) / 86400000) + 1 : 1;
}

export function adviseAd(input: AdInput, days: number): AdvisedProduct {
  const { spend, adRevenue, breakevenAcos: be } = input;
  const currentDaily = spend / Math.max(1, days);
  const acos = adRevenue > 0 ? spend / adRevenue : null;
  const base = { productId: input.productId, title: input.title, breakevenAcos: be, acos, currentDaily };
  const adsProfit = be === null ? null : adRevenue * be - spend;

  if (be === null) {
    return { ...base, action: "sin_costo", targetAcos: null, suggestedDaily: null, adsProfit, reason: "Cargá el costo del producto para saber si la publicidad le conviene." };
  }
  const target = be * TARGET_SHARE_OF_MARGIN;
  if (be <= 0) {
    return {
      ...base, action: "revisar_precio", targetAcos: null, suggestedDaily: 0, adsProfit,
      reason: "Pierde plata aun sin publicidad: revisá el precio o el costo antes de invertir.",
    };
  }
  if (spend > 0 && adRevenue <= 0) {
    return { ...base, action: "pausar", targetAcos: target, suggestedDaily: 0, adsProfit, reason: `Gastó ${money(spend)} y no vendió nada por publicidad.` };
  }
  if (acos === null) {
    return { ...base, action: "mantener", targetAcos: target, suggestedDaily: round100(currentDaily), adsProfit, reason: "Todavía no hay gasto para evaluar." };
  }
  if (acos > be) {
    const lossPer100 = (acos - be) * 100;
    if (acos > be * PAUSE_ABOVE) {
      return {
        ...base, action: "pausar", targetAcos: target, suggestedDaily: 0, adsProfit,
        reason: `Por cada $100 vendidos con publicidad gasta ${money(acos * 100)} y el margen aguanta ${money(be * 100)}: pierde ${money(lossPer100)}.`,
      };
    }
    return {
      ...base, action: "bajar", targetAcos: target, suggestedDaily: round100(currentDaily * (target / acos)), adsProfit,
      reason: `El ACOS (${pct(acos)}) pasa lo que aguanta el margen (${pct(be)}). Bajando el gasto se vuelve rentable.`,
    };
  }
  if (acos <= target && target / acos >= 1.1) {
    const step = Math.min(MAX_STEP_UP, target / acos);
    return {
      ...base, action: "subir", targetAcos: target, suggestedDaily: round100(currentDaily * step), adsProfit,
      reason: `Deja ${money((be - acos) * 100)} de ganancia por cada $100 vendidos con publicidad: hay lugar para invertir más.`,
    };
  }
  return {
    ...base, action: "mantener", targetAcos: target, suggestedDaily: round100(currentDaily), adsProfit,
    reason: `Gana con la publicidad pero cerca del límite (ACOS ${pct(acos)}, equilibrio ${pct(be)}).`,
  };
}

/**
 * Productos que hoy no se publicitan y conviene probar: venden solos y dejan
 * margen. El tope sugerido para empezar es lo que se puede gastar por día
 * para que UNA venta más por día siga dejando ganancia.
 */
export function adviseCandidate(c: CandidateInput): AdvisedProduct | null {
  const be = c.marginBeforeAds;
  if (be === null || be < MIN_MARGIN_TO_START || c.units < MIN_UNITS_TO_START || c.revenue <= 0) return null;
  const avgPrice = c.revenue / c.units;
  const target = be * TARGET_SHARE_OF_MARGIN;
  return {
    productId: c.productId,
    title: c.title,
    action: "probar",
    breakevenAcos: be,
    targetAcos: target,
    acos: null,
    currentDaily: 0,
    suggestedDaily: Math.max(500, round100(avgPrice * target)),
    adsProfit: null,
    reason: `Vendió ${c.units} u. sin publicidad y deja ${pct(be)} de margen: buen candidato para probar.`,
  };
}

const ORDER: AdviceAction[] = ["pausar", "bajar", "revisar_precio", "subir", "probar", "mantener", "sin_costo"];

export interface AdviceSummary {
  items: AdvisedProduct[];
  /** Plata que hoy se pierde por mes en los anuncios a pausar o bajar (ventas por Ads × margen − gasto, en negativo). */
  monthlyLoss: number;
  counts: Partial<Record<AdviceAction, number>>;
}

export function buildAdvice(ads: AdInput[], candidates: CandidateInput[], days: number): AdviceSummary {
  const items = [
    ...ads.filter((a) => a.spend > 0).map((a) => adviseAd(a, days)),
    ...candidates.map(adviseCandidate).filter((x): x is AdvisedProduct => x !== null),
  ];
  items.sort((a, b) => {
    const o = ORDER.indexOf(a.action) - ORDER.indexOf(b.action);
    if (o !== 0) return o;
    // Dentro de cada grupo, primero lo que más plata mueve.
    return Math.abs(b.adsProfit ?? b.suggestedDaily ?? 0) - Math.abs(a.adsProfit ?? a.suggestedDaily ?? 0);
  });
  const monthly = 30 / Math.max(1, days);
  const monthlyLoss = items
    .filter((i) => (i.action === "pausar" || i.action === "bajar" || i.action === "revisar_precio") && (i.adsProfit ?? 0) < 0)
    .reduce((s, i) => s + -(i.adsProfit ?? 0) * monthly, 0);
  const counts: Partial<Record<AdviceAction, number>> = {};
  for (const i of items) counts[i.action] = (counts[i.action] ?? 0) + 1;
  return { items, monthlyLoss, counts };
}
