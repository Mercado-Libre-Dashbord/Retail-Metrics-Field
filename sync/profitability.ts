export interface ProductCostEntry {
  cost: number;
  tax: number;
  validFrom: string;
}

export interface CostEntryResult {
  cost: number;
  tax: number;
}

export function getCostEntryAtDate(costs: ProductCostEntry[], date: string): CostEntryResult | null {
  let best: ProductCostEntry | null = null;
  let earliest: ProductCostEntry | null = null;
  for (const c of costs) {
    if (c.validFrom <= date && (best === null || c.validFrom >= best.validFrom)) {
      best = c;
    }
    if (earliest === null || c.validFrom < earliest.validFrom) {
      earliest = c;
    }
  }
  // Un costo cargado hoy para un producto con ventas viejas no tiene ningún
  // registro con validFrom <= date — pero la mejor estimación disponible para
  // esas ventas sigue siendo el primer costo que se cargó, no "sin dato".
  const chosen = best ?? earliest;
  return chosen ? { cost: chosen.cost, tax: chosen.tax } : null;
}

export function allocateAdsCost(
  dailySpend: number,
  unitsSoldThatDay: number,
  unitsInThisLine: number
): number {
  if (unitsSoldThatDay <= 0) return 0;
  return (dailySpend / unitsSoldThatDay) * unitsInThisLine;
}

import { ivaBalance } from "@/lib/iva";

export interface NetProfitInput {
  unitPrice: number;
  quantity: number;
  mlCommission: number;
  shippingCost: number;
  adsCostAllocated: number;
  costApplied: number | null;
  taxApplied: number | null;
  /**
   * Si la cuenta es Responsable Inscripto. El precio de Mercado Libre incluye
   * IVA solo para ese régimen; un Monotributista o un exento no tienen débito
   * ni crédito fiscal que calcular, y restarles un saldo de IVA que no existe
   * les infla artificialmente el costo y les esconde ganancia real. Campo
   * obligatorio (no default) a propósito: para algo tan sensible al bolsillo,
   * un olvido tiene que ser un error de compilación, no un silencio.
   */
  appliesIva: boolean;
}

/**
 * IVA que esta línea de venta le deja a pagar a AFIP (débito menos crédito).
 * Se expone aparte de calculateNetProfit para poder mostrarlo como una franja
 * propia en el gráfico de "de qué está hecha tu facturación".
 *
 * Devuelve 0 sin calcular nada si la cuenta no factura con IVA discriminado
 * (Monotributo, exento): no hay débito fiscal que pagar.
 */
export function calculateIva(input: NetProfitInput): number {
  if (!input.appliesIva) return 0;
  return ivaBalance({
    grossRevenue: input.unitPrice * input.quantity,
    mlCharges: input.mlCommission + input.shippingCost + input.adsCostAllocated,
    productCost: (input.costApplied ?? 0) * input.quantity,
  });
}

export function calculateNetProfit(input: NetProfitInput): number | null {
  if (input.costApplied === null) return null;
  return (
    input.unitPrice * input.quantity -
    input.mlCommission -
    input.shippingCost -
    input.adsCostAllocated -
    input.costApplied * input.quantity -
    // Impuestos cargados a mano por producto (IIBB, internos): el IVA NO va
    // acá, se calcula solo abajo.
    (input.taxApplied ?? 0) * input.quantity -
    calculateIva(input)
  );
}
