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
