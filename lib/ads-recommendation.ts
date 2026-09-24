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

export interface AcosMetrics {
  /** Publicidad ÷ facturación del producto. Mercado Libre no separa qué
   * ventas vinieron puntualmente de un anuncio, así que se mide contra TODA la
   * facturación de la publicación (técnicamente un TACOS por producto). */
  acos: number | null;
  /** Hasta qué ACOS la publicidad todavía no se come la ganancia: el margen
   * antes de Ads (ya con comisión, envío, costo e impuestos) sobre la
   * facturación. Por encima de este número, cada venta con Ads pierde plata.
   * Negativo = el producto pierde aun sin publicidad. */
  breakevenAcos: number | null;
  /** Lo máximo que se podría haber gastado en Ads en el período sin quedar
   * en pérdida (el margen antes de Ads). 0 si ni sin Ads da ganancia. */
  maxAdSpend: number;
}

export function acosMetrics(revenue: number, netProfit: number, adSpend: number): AcosMetrics {
  const marginBeforeAds = netProfit + adSpend;
  return {
    acos: revenue > 0 ? adSpend / revenue : null,
    breakevenAcos: revenue > 0 ? marginBeforeAds / revenue : null,
    maxAdSpend: Math.max(0, marginBeforeAds),
  };
}
