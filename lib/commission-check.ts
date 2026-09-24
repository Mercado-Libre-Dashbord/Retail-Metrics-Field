export interface CommissionCheckInput {
  orders: number;
  billed: number;
  calculated: number;
  ratio: number;
  multiUnitOrders: number;
  multiUnitRatio: number | null;
  ivaIsCost: boolean;
}

export type CommissionCheckStatus = "ok" | "iva" | "multi_unit" | "diff";

export interface CommissionCheckVerdict {
  status: CommissionCheckStatus;
  title: string;
  detail: string;
}

const IVA = 0.21;

function pct(n: number) {
  return `${(n * 100).toFixed(1)}%`;
}

function fmt(n: number) {
  return n.toLocaleString("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 });
}

/**
 * Traduce la conciliación orden por orden de la comisión (ver /api/billing)
 * a un veredicto en castellano. Es la forma de confirmar con los datos de la
 * propia cuenta —no con una suposición— que la comisión que descuenta la app
 * es la que ML cobra, incluido el IVA de su factura.
 */
export function interpretCommissionCheck(c: CommissionCheckInput): CommissionCheckVerdict {
  const near = (value: number, target: number) => Math.abs(value - target) <= 0.03;
  const basis = `Comparado orden por orden en ${c.orders} venta(s): ML facturó ${fmt(c.billed)}, la app descontó ${fmt(c.calculated)}.`;

  // Primero lo más específico: si solo las ventas de varias unidades no
  // cierran, el problema es ese y no el IVA.
  if (c.multiUnitRatio !== null && c.multiUnitOrders > 0 && !near(c.multiUnitRatio, c.ratio) && near(c.ratio, 1)) {
    return {
      status: "multi_unit",
      title: "La comisión no cierra en ventas de más de una unidad",
      detail: `${basis} En las ${c.multiUnitOrders} venta(s) de varias unidades la diferencia es de ${pct(c.multiUnitRatio - 1)}.`,
    };
  }
  if (near(c.ratio, 1)) {
    return { status: "ok", title: "La comisión coincide con la factura de Mercado Libre", detail: basis };
  }
  if (near(c.ratio, 1 + IVA)) {
    const ivaAmount = c.billed - c.calculated;
    return {
      status: "iva",
      title: "Mercado Libre te factura la comisión con IVA encima",
      detail: c.ivaIsCost
        ? `${basis} La diferencia (${fmt(ivaAmount)}) es el IVA de la factura de ML: como no discriminás IVA, es un costo que la ganancia neta todavía no descuenta.`
        : `${basis} La diferencia (${fmt(ivaAmount)}) es el IVA de la factura de ML: como Responsable Inscripto lo recuperás como crédito fiscal, no es costo.`,
    };
  }
  return {
    status: "diff",
    title: `La comisión calculada difiere ${pct(c.ratio - 1)} de la facturada`,
    detail: `${basis} Puede haber cargos que ML factura en otro período que la venta; si la diferencia se mantiene, avisanos.`,
  };
}
