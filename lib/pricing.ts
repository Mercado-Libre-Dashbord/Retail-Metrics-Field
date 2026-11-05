/**
 * Cuentas de precio por publicación: piso (el precio que no deja ni pierde
 * plata) y precio sugerido (el que deja el margen objetivo).
 *
 * Todo sale de lo que de verdad pasó en las ventas recientes de cada
 * publicación, no de tablas de comisiones:
 * - Comisión, IVA, otros impuestos y publicidad se toman como % del precio
 *   (escalan con el precio: si subís el precio, sube la comisión). La comisión
 *   de ML ya incluye el costo de las cuotas que ofrezcas.
 * - El envío a cargo del vendedor y el costo del producto son montos fijos por
 *   unidad (no cambian con el precio).
 *
 * Con eso, lo que deja una unidad vendida a precio P es:
 *   ganancia(P) = P × (1 − tasas) − costo − envío
 * y de ahí salen el piso (ganancia = 0) y el sugerido (ganancia = margen × P).
 *
 * Una publicación con pocas ventas en el período no tiene tasas propias
 * confiables: usa las de toda la cuenta y queda marcada como estimada.
 */

export const MIN_UNITS_FOR_OWN_RATES = 3;

/** Lo vendido por una publicación (o la cuenta entera) en el período de referencia. */
export interface SalesTotals {
  units: number;
  revenue: number;
  commission: number;
  shipping: number;
  iva: number;
  tax: number;
  ads: number;
}

export interface PricingRates {
  /** Comisión de ML ÷ facturación. */
  commission: number;
  /** IVA ÷ facturación. */
  iva: number;
  /** Otros impuestos (IIBB, etc.) ÷ facturación. */
  tax: number;
  /** Publicidad repartida en las ventas ÷ facturación. */
  ads: number;
  /** Envío a cargo del vendedor, por unidad. */
  shippingPerUnit: number;
  /** Si salen de la cuenta entera porque la publicación vendió poco. */
  estimated: boolean;
}

export type PricingStatus = "sin_costo" | "sin_margen_posible" | "bajo_piso" | "bajo_objetivo" | "ok";

export interface PricingResult {
  rates: PricingRates;
  /** Suma de las tasas que escalan con el precio. */
  variableRate: number;
  /** Lo que deja una unidad al precio actual (null sin costo). */
  unitProfit: number | null;
  /** unitProfit ÷ precio actual. */
  margin: number | null;
  /** Precio en el que la unidad no deja ni pierde plata. */
  floorPrice: number | null;
  /** Precio que deja el margen objetivo, redondeado hacia arriba a $10. */
  suggestedPrice: number | null;
  status: PricingStatus;
}

function safeDiv(a: number, b: number): number {
  return b > 0 ? a / b : 0;
}

export function ratesFrom(own: SalesTotals, account: SalesTotals): PricingRates {
  const useOwn = own.units >= MIN_UNITS_FOR_OWN_RATES && own.revenue > 0;
  const src = useOwn ? own : account;
  return {
    commission: safeDiv(src.commission, src.revenue),
    iva: safeDiv(src.iva, src.revenue),
    tax: safeDiv(src.tax, src.revenue),
    ads: safeDiv(src.ads, src.revenue),
    // El envío es por unidad de ESTA publicación si vendió lo suficiente: el
    // de la cuenta mezcla productos chicos y grandes.
    shippingPerUnit: safeDiv(src.shipping, src.units),
    estimated: !useOwn,
  };
}

export function roundUpTo10(n: number): number {
  return Math.ceil(n / 10) * 10;
}

export function computePricing(
  price: number,
  cost: number | null,
  rates: PricingRates,
  targetMargin: number,
  opts: { includeAds?: boolean } = {}
): PricingResult {
  const includeAds = opts.includeAds ?? true;
  const variableRate = rates.commission + rates.iva + rates.tax + (includeAds ? rates.ads : 0);
  if (cost === null || !Number.isFinite(cost)) {
    return { rates, variableRate, unitProfit: null, margin: null, floorPrice: null, suggestedPrice: null, status: "sin_costo" };
  }
  const fixed = cost + rates.shippingPerUnit;
  const unitProfit = price * (1 - variableRate) - fixed;
  const margin = price > 0 ? unitProfit / price : null;
  const floorDen = 1 - variableRate;
  const floorPrice = floorDen > 0 ? fixed / floorDen : null;
  const targetDen = 1 - variableRate - targetMargin;
  const suggestedPrice = targetDen > 0 ? roundUpTo10(fixed / targetDen) : null;

  let status: PricingStatus;
  if (floorPrice === null) status = "sin_margen_posible";
  else if (price < floorPrice) status = "bajo_piso";
  else if (margin !== null && margin < targetMargin - 0.005) status = "bajo_objetivo";
  else status = "ok";

  return { rates, variableRate, unitProfit, margin, floorPrice, suggestedPrice, status };
}

/** Margen que deja un precio cualquiera, con las mismas tasas (para previsualizar un cambio). */
export function marginAt(price: number, cost: number, rates: PricingRates, includeAds = true): number | null {
  if (price <= 0) return null;
  const variableRate = rates.commission + rates.iva + rates.tax + (includeAds ? rates.ads : 0);
  return (price * (1 - variableRate) - cost - rates.shippingPerUnit) / price;
}
