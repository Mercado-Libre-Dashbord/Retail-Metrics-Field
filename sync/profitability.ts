export interface ProductCostEntry {
  cost: number;
  tax: number;
  validFrom: string;
}

export interface CostEntryResult {
  cost: number;
  tax: number;
}

/**
 * El costo que se aplica a una venta: el ÚLTIMO que cargó el vendedor, para
 * TODAS sus ventas, sin importar la fecha.
 *
 * Antes cada costo tenía "vigencia desde" el momento en que se cargaba, y las
 * ventas viejas conservaban el costo anterior. En la práctica eso era una
 * trampa: el vendedor corregía un costo mal cargado, el margen cambiaba pero
 * el beneficio de las ventas ya hechas no, y la única salida era "eliminar el
 * costo y volver a cargarlo". Ahora cargar un costo nuevo recalcula todo el
 * historial, que es lo que cualquiera espera. El historial de costos se sigue
 * guardando (auditoría), pero ya no reparte ventas entre versiones.
 */
export function getCurrentCostEntry(costs: ProductCostEntry[]): CostEntryResult | null {
  let latest: ProductCostEntry | null = null;
  for (const c of costs) {
    if (latest === null || c.validFrom >= latest.validFrom) latest = c;
  }
  return latest ? { cost: latest.cost, tax: latest.tax } : null;
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
