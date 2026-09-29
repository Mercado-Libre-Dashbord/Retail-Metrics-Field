export type AdsRecommendation = "pausar" | "mantener" | "aumentar";

/**
 * A qué publicación conviene seguir pagándole Ads, a cuál dejar de pagarle,
 * y a cuál ponerle más plata — a partir de la ganancia neta real (ya con el
 * gasto de Ads descontado) y de cuánto se gastó en Ads.
 *
 * Usado tanto en la pantalla de Campañas como en el estado financiero en
 * Excel: misma cuenta en los dos lados, para no mostrar una recomendación
 * distinta según por dónde se mire.
 */
export function recommendAdsAction(netProfit: number, adSpend: number): AdsRecommendation {
  if (netProfit < 0) return "pausar";
  // Ganancia que dejaría este producto SI no se le hubiera puesto ni un
  // peso de publicidad — la base real para juzgar si conviene invertir más.
  const marginBeforeAds = netProfit + adSpend;
  if (marginBeforeAds > 0 && adSpend < marginBeforeAds * 0.5) return "aumentar";
  return "mantener";
}

export type AttributedRecommendation = AdsRecommendation | "sin_costo";

export interface AttributedAdsMetrics {
  /** Ventas atribuidas al anuncio ÷ inversión. */
  roas: number | null;
  /** Inversión ÷ ventas atribuidas al anuncio. */
  acos: number | null;
  /** El ACOS máximo que aguanta el producto antes de perder plata con cada
   * venta por publicidad: su margen antes de Ads. */
  breakevenAcos: number | null;
  /** Lo que dejaron las ventas por publicidad después de pagar la
   * publicidad: ventas atribuidas × margen antes de Ads − inversión. */
  adsProfit: number | null;
  recommendation: AttributedRecommendation;
}

/**
 * Métricas y recomendación de un anuncio con lo que Mercado Ads atribuye a
 * ese anuncio (no con toda la facturación del producto, que mezcla ventas
 * orgánicas y daba un ROAS inflado).
 *
 * - Gasta y no vendió nada por publicidad: pausar (no hace falta el costo).
 * - Sin margen conocido (falta el costo): no se recomienda nada.
 * - El ACOS supera el de equilibrio (cada venta por Ads pierde plata): pausar.
 * - ACOS por debajo de la mitad del de equilibrio: aumentar.
 * - Si no, mantener.
 */
export function attributedAdsMetrics(input: {
  spend: number;
  adRevenue: number;
  /** (ganancia + publicidad) ÷ facturación del producto; null si falta costo. */
  marginBeforeAds: number | null;
}): AttributedAdsMetrics {
  const { spend, adRevenue, marginBeforeAds } = input;
  const roas = spend > 0 ? adRevenue / spend : null;
  const acos = adRevenue > 0 ? spend / adRevenue : null;
  const adsProfit = marginBeforeAds === null ? null : adRevenue * marginBeforeAds - spend;
  let recommendation: AttributedRecommendation;
  // Gastar sin vender nada por publicidad es plata perdida sea cual sea el
  // margen: no hace falta el costo para saberlo.
  if (spend > 0 && adRevenue <= 0) recommendation = "pausar";
  else if (marginBeforeAds === null) recommendation = "sin_costo";
  else if (spend > 0 && (acos === null || acos > marginBeforeAds)) recommendation = "pausar";
  else if (acos !== null && acos < marginBeforeAds * 0.5) recommendation = "aumentar";
  else recommendation = "mantener";
  return { roas, acos, breakevenAcos: marginBeforeAds, adsProfit, recommendation };
}
