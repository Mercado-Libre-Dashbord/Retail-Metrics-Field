import { ivaBalance } from "./iva";

/**
 * Margen de un producto, con los mismos descuentos que la ganancia neta de
 * cada venta: comisión y cargo fijo de Mercado Libre, envío que paga el
 * vendedor, publicidad, costo, otros impuestos e IVA.
 *
 * Tres niveles, del más al menos confiable:
 * - "real": el producto vendió en el período — sale de esas ventas tal cual
 *   (lo que ML efectivamente cobró en cada una).
 * - "estimado": no vendió en el período, pero hay estimación de lo que ML
 *   cobraría hoy por venderlo a su precio (ver syncProductEstimates).
 * - "bruto": solo precio − costo − otros impuestos. Es el margen viejo: queda
 *   únicamente como último recurso (sin estimación todavía) y la pantalla lo
 *   aclara, porque es optimista — no descuenta ni comisión ni envío.
 */
export type MarginKind = "real" | "estimado" | "bruto";

/** Todo por UNIDAD. */
export interface MarginBreakdown {
  price: number;
  commission: number;
  shipping: number;
  ads: number;
  cost: number;
  taxes: number;
  iva: number;
  net: number;
}

export interface ProductMargin {
  kind: MarginKind;
  /** Ganancia neta ÷ precio (0,25 = 25%). */
  pct: number;
  perUnit: MarginBreakdown;
  /** Estimado sin dato del envío gratis: el margen real puede ser menor. */
  missingShipping: boolean;
}

/** Sumas de las ventas del producto en el período (ver /api/products). */
export interface RealizedSales {
  units: number;
  revenue: number;
  commission: number;
  shipping: number;
  ads: number;
  cost: number;
  taxes: number;
  iva: number;
  net: number;
  /** Líneas sin costo aplicado: si hay alguna, las sumas no son la ganancia real. */
  linesWithoutCost: number;
}

/** Lo guardado por syncProductEstimates. */
export interface ChargeEstimate {
  /** Precio con el que se estimó. */
  price: number | null;
  saleFee: number | null;
  fixedFee: number | null;
  /** Null = no se sabe (con envío gratis, falta el dato). */
  shippingCost: number | null;
}

export interface MarginInput {
  currentPrice: number;
  currentCost: number | null;
  otherTaxRate: number;
  appliesIva: boolean;
  realized: RealizedSales | null;
  estimate: ChargeEstimate | null;
}

/**
 * Cargo de venta al precio actual. Si el precio cambió desde la estimación
 * (por ejemplo, se editó desde el panel), se reescala la parte porcentual y
 * se mantiene la fija, en vez de mostrar un cargo de otro precio.
 */
export function saleFeeAtPrice(estimate: ChargeEstimate, price: number): number | null {
  if (estimate.saleFee === null || estimate.price === null || !(estimate.price > 0)) return null;
  if (Math.abs(estimate.price - price) < 0.005) return estimate.saleFee;
  const fixed = estimate.fixedFee ?? 0;
  const pct = (estimate.saleFee - fixed) / estimate.price;
  return Math.max(0, pct * price + fixed);
}

export function computeProductMargin(input: MarginInput): ProductMargin | null {
  const { realized } = input;
  if (realized && realized.units > 0 && realized.revenue > 0 && realized.linesWithoutCost === 0) {
    const u = realized.units;
    return {
      kind: "real",
      pct: realized.net / realized.revenue,
      perUnit: {
        price: realized.revenue / u,
        commission: realized.commission / u,
        shipping: realized.shipping / u,
        ads: realized.ads / u,
        cost: realized.cost / u,
        taxes: realized.taxes / u,
        iva: realized.iva / u,
        net: realized.net / u,
      },
      missingShipping: false,
    };
  }

  const price = input.currentPrice;
  const cost = input.currentCost;
  if (cost === null || !(price > 0)) return null;
  const taxes = price * input.otherTaxRate;

  const fee = input.estimate ? saleFeeAtPrice(input.estimate, price) : null;
  if (fee !== null) {
    const shipping = input.estimate?.shippingCost ?? null;
    const ship = shipping ?? 0;
    const iva = input.appliesIva ? ivaBalance({ grossRevenue: price, mlCharges: fee + ship, productCost: cost }) : 0;
    const net = price - fee - ship - cost - taxes - iva;
    return {
      kind: "estimado",
      pct: net / price,
      perUnit: { price, commission: fee, shipping: ship, ads: 0, cost, taxes, iva, net },
      missingShipping: shipping === null,
    };
  }

  const net = price - cost - taxes;
  return {
    kind: "bruto",
    pct: net / price,
    perUnit: { price, commission: 0, shipping: 0, ads: 0, cost, taxes, iva: 0, net },
    missingShipping: false,
  };
}
