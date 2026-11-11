import type { QueryExecutor } from "@/db/client";
import { hasColumn } from "@/db/schema-capabilities";
import { ivaFromGross } from "@/lib/iva";
import { revenueStatusFilter } from "@/lib/order-status";
import { BUCKET_LABEL, MANUAL_DETAIL_TYPE, classifyCharge, type ChargeBucket } from "./billing";

/**
 * Lo que la ganancia neta del período tiene que restar ADEMÁS de lo que ya se
 * resta venta por venta.
 *
 * Venta por venta (order_items.net_profit) ya están: comisión, envío, costo,
 * impuestos, IVA y la parte de Mercado Ads repartida entre las ventas de cada
 * día. Lo que no está atado a una venta se resta acá, una sola vez:
 *
 * - Publicidad que no quedó repartida en ninguna venta: Meta, Google y TikTok
 *   cargados a mano (nunca se reparten), y el gasto de Mercado Ads de días sin
 *   ventas. Se toma el gasto total del período menos lo ya repartido, así la
 *   publicidad se resta completa y nunca dos veces.
 * - Cargos de la factura de Mercado Libre que no son de una venta: Full
 *   (almacenamiento, retiros) y "otros cargos" (multas, cargos varios), los
 *   sincronizados sin orden asociada y los cargados a mano.
 *
 * - Diferencia con la factura: lo que la orden informa de comisión y envío no
 *   siempre coincide con lo que Mercado Libre termina cobrando. En las ventas
 *   ya facturadas se usa la factura, y además se sacan las ventas devueltas y
 *   se restan los cargos que quedan en devueltas y canceladas: ver
 *   invoiceDiffByMonth.
 *
 * Y NO se resta de la factura, para no duplicar:
 * - Comisión y envío: ya están en cada venta (y se corrigen con la factura).
 * - Publicidad: ya está, desde el gasto de Mercado Ads.
 * - Impuestos y percepciones: son pagos a cuenta de impuestos; el IIBB y el
 *   IVA ya se restan con la alícuota de la cuenta.
 * - Un cargo sincronizado que viene atado a una orden: es de esa venta.
 *
 * Para Responsables Inscriptos con IVA teórico (meses sin IVA real cargado),
 * los cargos de Mercado Libre traen IVA que es crédito fiscal: se descuenta
 * del IVA, igual que se hace con la comisión venta por venta. Con IVA real
 * cargado ese mes, ese crédito ya está adentro de lo que se pagó.
 */

export type ChargeTreatment = "subtracted" | "per_sale" | "in_ads" | "tax";

export const TREATMENT_LABEL: Record<ChargeTreatment, string> = {
  subtracted: "Se resta de la ganancia",
  per_sale: "Restado venta por venta, con el monto de la factura",
  in_ads: "Ya restado en Publicidad",
  tax: "No se resta: pago a cuenta de impuestos",
};

export function chargeTreatment(bucket: ChargeBucket, linkedToOrder: boolean, manual: boolean): ChargeTreatment {
  if (bucket === "comision" || bucket === "envio") return "per_sale";
  if (bucket === "publicidad") return "in_ads";
  if (bucket === "impuesto") return "tax";
  // Full u otros: si Mercado Libre lo ató a una orden, es un cargo de esa
  // venta y no un gasto aparte.
  return linkedToOrder && !manual ? "per_sale" : "subtracted";
}

/** Fecha contable de un cargo: la del cargo, o el mes de la factura si no trae fecha. */
export const CHARGE_DATE_SQL = `COALESCE(charged_at::date, to_date(period_key, 'YYYY-MM-DD'))`;

export interface ChargeDetail {
  bucket: ChargeBucket;
  label: string;
  concept: string;
  linkedToOrder: boolean;
  manual: boolean;
  treatment: ChargeTreatment;
  count: number;
  amount: number;
}

interface RawCharge {
  month: string;
  concept: string | null;
  detailType: string | null;
  detailSubType: string | null;
  linked: boolean;
  count: string | number;
  amount: string | number;
}

async function loadCharges(db: QueryExecutor, accountId: string, from: string, to: string): Promise<RawCharge[]> {
  if (!(await hasColumn(db, "billing_charges", "detail_id"))) return [];
  const result = await db.query<RawCharge>(
    `SELECT to_char(${CHARGE_DATE_SQL}, 'YYYY-MM') as month, concept, detail_type as "detailType",
            detail_sub_type as "detailSubType", (order_id IS NOT NULL AND order_id <> '') as linked,
            COUNT(*) as count, SUM(${SIGNED_AMOUNT_SQL}) as amount
       FROM billing_charges
      WHERE account_id = $1 AND ${CHARGE_DATE_SQL} BETWEEN $2::date AND $3::date
      GROUP BY 1, 2, 3, 4, 5`,
    [accountId, from, to]
  );
  return result.rows;
}

function toDetail(r: RawCharge): ChargeDetail & { month: string } {
  const bucket = classifyCharge(r.concept, r.detailType, r.detailSubType);
  const manual = r.detailType === MANUAL_DETAIL_TYPE;
  return {
    month: r.month,
    bucket,
    label: BUCKET_LABEL[bucket],
    concept: (manual ? "Cargado a mano" : r.concept ?? r.detailSubType ?? r.detailType) ?? "Sin concepto",
    linkedToOrder: Boolean(r.linked),
    manual,
    // Solo Product Ads se sincroniza desde Mercado Ads. Otra publicidad de la
    // factura (p. ej. "Publicidad de Seguidores") no está en ningún otro lado:
    // se resta desde acá.
    treatment:
      bucket === "publicidad" && !manual && !/products? ads/i.test(r.concept ?? "")
        ? "subtracted"
        : chargeTreatment(bucket, Boolean(r.linked), manual),
    count: Number(r.count),
    amount: Number(r.amount),
  };
}

/** Detalle de la factura de ML del período, agrupado por concepto, con qué se hace con cada uno. */
export async function chargeDetails(db: QueryExecutor, accountId: string, from: string, to: string): Promise<ChargeDetail[]> {
  const merged = new Map<string, ChargeDetail>();
  for (const raw of await loadCharges(db, accountId, from, to)) {
    const { month: _month, ...d } = toDetail(raw);
    const key = [d.bucket, d.concept, d.linkedToOrder, d.manual].join("|");
    const prev = merged.get(key);
    if (prev) { prev.count += d.count; prev.amount += d.amount; } else merged.set(key, { ...d });
  }
  return [...merged.values()].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
}

export interface PeriodAdjustments {
  /** Publicidad total del período (Mercado Ads + cargada a mano). */
  adSpend: number;
  /** Parte de la publicidad que ya está restada venta por venta. */
  adsInSales: number;
  /** Publicidad que se resta acá: adSpend − adsInSales. */
  adsNotInSales: number;
  /** Cargos de ML que se restan acá, por concepto. */
  full: number;
  otherCharges: number;
  /**
   * Factura de ML vs. lo estimado, en las ventas ya facturadas: lo que ML
   * cobró atado a cada venta menos la comisión y el envío que se habían
   * calculado. Positivo = ML cobró más de lo estimado (se resta).
   */
  invoiceDiff: number;
  /** Ventas del período, y cuántas ya tienen su factura para conciliar. */
  ordersTotal: number;
  ordersInvoiced: number;
  /** En las ventas conciliadas: lo estimado y lo facturado. */
  invoiceEstimated: number;
  invoiceBilled: number;
  /**
   * Ventas con el cargo por vender anulado (devueltas) que la orden todavía
   * muestra como pagadas: cuántas, cuánto habían facturado, la ganancia que se
   * les saca y los cargos que les quedaron sin anular (se restan).
   */
  refundedOrders: number;
  refundedRevenue: number;
  refundedProfit: number;
  refundedCosts: number;
  /** Cargos que quedaron sin anular en ventas canceladas (se restan). */
  cancelledCosts: number;
  /** IVA crédito de esos cargos (solo RI con IVA teórico). Se suma. */
  ivaCredit: number;
  /** Lo que hay que sumarle a la ganancia de las ventas (negativo = resta). */
  total: number;
}

export interface MonthAdjustments extends PeriodAdjustments {
  month: string;
}

function emptyAdjustments(): PeriodAdjustments {
  return {
    adSpend: 0, adsInSales: 0, adsNotInSales: 0, full: 0, otherCharges: 0,
    invoiceDiff: 0, ordersTotal: 0, ordersInvoiced: 0, invoiceEstimated: 0, invoiceBilled: 0,
    refundedOrders: 0, refundedRevenue: 0, refundedProfit: 0, refundedCosts: 0, cancelledCosts: 0,
    ivaCredit: 0, total: 0,
  };
}

/**
 * Un cargo de tipo BONUS es una bonificación: plata que ML devuelve. Se toma
 * siempre como negativo, venga con el signo que venga.
 */
export const SIGNED_AMOUNT_SQL = `(CASE WHEN upper(COALESCE(detail_type, '')) = 'BONUS' THEN -abs(amount) ELSE amount END)`;

const CHARGE_KEY_SQL = `(COALESCE(concept, '') || '|' || COALESCE(detail_type, '') || '|' || COALESCE(detail_sub_type, ''))`;

interface InvoiceMonth {
  month: string;
  ordersTotal: number;
  ordersInvoiced: number;
  estimated: number;
  billed: number;
  refundedOrders: number;
  refundedRevenue: number;
  refundedProfit: number;
  refundedCosts: number;
  cancelledCosts: number;
}

/** Parte del cargo por vender que tiene que estar anulada para dar la venta por devuelta. */
const ANNULLED_SHARE = 0.9;

/**
 * Factura contra estimación, mes por mes (por fecha de la venta).
 *
 * Lo que guarda cada venta de comisión y envío es lo que informó la orden al
 * sincronizarla. La factura de Mercado Libre es lo que cobró de verdad, y trae
 * cada cargo atado a su venta (billing_charges.order_id). Las anulaciones
 * vienen como filas de tipo BONUS con monto positivo: se restan.
 *
 * Por cada venta válida y con costo cargado se concilian dos cosas por
 * separado, cada una solo si la factura ya trae cargos de ese tipo para esa
 * venta (si no, queda lo estimado: el envío a veces se factura más tarde):
 *   - Cargos por vender: "Cargo por vender" + "Costo por unidad vendida" +
 *     "Costo por ofrecer cuotas" + otros cargos de la venta (p. ej. "Cargo por
 *     devolución"), contra la comisión guardada (el sale_fee de la orden, que
 *     ya incluye el costo por unidad y las cuotas).
 *   - Envío: los cargos por envíos, contra el envío guardado.
 *
 * Ventas devueltas: si el cargo por vender de una venta está anulado, la venta
 * se cayó aunque la orden siga figurando como pagada. Se saca su ganancia y
 * se restan los cargos que hayan quedado sin anular (devolución, envío).
 * Ventas canceladas: no suman ganancia, pero los cargos que les quedaron sin
 * anular son plata que salió y se restan.
 *
 * Quedan afuera la publicidad (se resta desde Mercado Ads) y los impuestos y
 * percepciones (pagos a cuenta; el IVA y los otros impuestos se restan aparte).
 */
export async function invoiceDiffByMonth(db: QueryExecutor, accountId: string, from: string, to: string): Promise<InvoiceMonth[]> {
  if (!(await hasColumn(db, "billing_charges", "detail_id"))) return [];
  // Los conceptos se clasifican acá (por texto, ver classifyCharge) y se le
  // pasan a la consulta como listas.
  const kinds = await db.query<{ key: string; concept: string | null; dt: string | null; dst: string | null }>(
    `SELECT DISTINCT ${CHARGE_KEY_SQL} as key, concept, detail_type as dt, detail_sub_type as dst
       FROM billing_charges
      WHERE account_id = $1 AND order_id IS NOT NULL AND order_id <> ''`,
    [accountId]
  );
  const saleKeys: string[] = [], feeKeys: string[] = [], shipKeys: string[] = [];
  for (const k of kinds.rows) {
    if (k.dt === MANUAL_DETAIL_TYPE) continue;
    const bucket = classifyCharge(k.concept, k.dt, k.dst);
    if (bucket === "comision") saleKeys.push(k.key);
    if (bucket === "comision" || bucket === "otro" || bucket === "full") feeKeys.push(k.key);
    if (bucket === "envio") shipKeys.push(k.key);
  }
  if (feeKeys.length === 0 && shipKeys.length === 0) return [];

  const isBonus = `upper(COALESCE(bc.detail_type, '')) = 'BONUS'`;
  const result = await db.query<Record<string, string | number>>(
    `WITH sales AS (
       SELECT o.id, to_char(o.date_created, 'YYYY-MM') as month,
              (${revenueStatusFilter()}) as valid,
              SUM(oi.ml_commission) as est_fee, SUM(oi.shipping_cost) as est_ship,
              SUM(oi.unit_price * oi.quantity) as revenue,
              COALESCE(SUM(oi.net_profit), 0) as net,
              bool_and(oi.net_profit IS NOT NULL) as counted
         FROM orders o JOIN order_items oi ON oi.account_id = o.account_id AND oi.order_id = o.id
        WHERE o.account_id = $1 AND o.date_created::date BETWEEN $2::date AND $3::date
        GROUP BY o.id, o.date_created, o.status
     ), billed AS (
       SELECT bc.order_id,
              COALESCE(SUM(${SIGNED_AMOUNT_SQL}) FILTER (WHERE ${CHARGE_KEY_SQL} = ANY($4::text[])), 0) as fee_net,
              COUNT(*) FILTER (WHERE ${CHARGE_KEY_SQL} = ANY($4::text[])) as fee_n,
              COALESCE(SUM(${SIGNED_AMOUNT_SQL}) FILTER (WHERE ${CHARGE_KEY_SQL} = ANY($5::text[])), 0) as ship_net,
              COUNT(*) FILTER (WHERE ${CHARGE_KEY_SQL} = ANY($5::text[])) as ship_n,
              COALESCE(SUM(abs(bc.amount)) FILTER (WHERE ${CHARGE_KEY_SQL} = ANY($6::text[]) AND NOT ${isBonus}), 0) as sale_charge,
              COALESCE(SUM(abs(bc.amount)) FILTER (WHERE ${CHARGE_KEY_SQL} = ANY($6::text[]) AND ${isBonus}), 0) as sale_bonus
         FROM billing_charges bc
        WHERE bc.account_id = $1 AND bc.order_id IN (SELECT id FROM sales)
        GROUP BY bc.order_id
     ), j AS (
       SELECT s.*, COALESCE(b.fee_net, 0) as fee_net, COALESCE(b.fee_n, 0) as fee_n,
              COALESCE(b.ship_net, 0) as ship_net, COALESCE(b.ship_n, 0) as ship_n,
              (s.valid AND COALESCE(b.sale_charge, 0) > 0 AND COALESCE(b.sale_bonus, 0) >= ${ANNULLED_SHARE} * b.sale_charge) as annulled
         FROM sales s LEFT JOIN billed b ON b.order_id = s.id
     )
     SELECT month,
            COUNT(*) FILTER (WHERE valid AND counted AND NOT annulled) as orders_total,
            COUNT(*) FILTER (WHERE valid AND counted AND NOT annulled AND (fee_n > 0 OR ship_n > 0)) as orders_invoiced,
            COALESCE(SUM((CASE WHEN fee_n > 0 THEN est_fee ELSE 0 END) + (CASE WHEN ship_n > 0 THEN est_ship ELSE 0 END))
                     FILTER (WHERE valid AND counted AND NOT annulled), 0) as estimated,
            COALESCE(SUM(fee_net + ship_net) FILTER (WHERE valid AND counted AND NOT annulled), 0) as billed,
            COUNT(*) FILTER (WHERE annulled) as refunded_orders,
            COALESCE(SUM(revenue) FILTER (WHERE annulled), 0) as refunded_revenue,
            COALESCE(SUM(net) FILTER (WHERE annulled), 0) as refunded_profit,
            COALESCE(SUM(GREATEST(fee_net + ship_net, 0)) FILTER (WHERE annulled), 0) as refunded_costs,
            COALESCE(SUM(GREATEST(fee_net + ship_net, 0)) FILTER (WHERE NOT valid), 0) as cancelled_costs
       FROM j GROUP BY month`,
    [accountId, from, to, feeKeys, shipKeys, saleKeys]
  );
  return result.rows.map((r) => ({
    month: String(r.month),
    ordersTotal: Number(r.orders_total),
    ordersInvoiced: Number(r.orders_invoiced),
    estimated: Number(r.estimated),
    billed: Number(r.billed),
    refundedOrders: Number(r.refunded_orders),
    refundedRevenue: Number(r.refunded_revenue),
    refundedProfit: Number(r.refunded_profit),
    refundedCosts: Number(r.refunded_costs),
    cancelledCosts: Number(r.cancelled_costs),
  }));
}

/**
 * Ajustes del período, mes por mes (el IVA real se carga por mes). Las fechas
 * siguen el mismo criterio que el resto del Resumen: la de la orden, el día
 * del gasto en publicidad y la fecha del cargo.
 */
export async function monthlyAdjustments(
  db: QueryExecutor,
  accountId: string,
  from: string,
  to: string,
  appliesIva: boolean
): Promise<MonthAdjustments[]> {
  const ads = await db.query<{ month: string; ml: string | number; other: string | number }>(
    `SELECT to_char(date, 'YYYY-MM') as month,
            COALESCE(SUM(CASE WHEN channel = 'mercado_ads' THEN amount ELSE 0 END), 0) as ml,
            COALESCE(SUM(CASE WHEN channel <> 'mercado_ads' THEN amount ELSE 0 END), 0) as other
       FROM ads_spend WHERE account_id = $1 AND date BETWEEN $2::date AND $3::date
      GROUP BY 1`,
    [accountId, from, to]
  );
  // Toda la publicidad repartida en ventas válidas, tengan o no costo: una
  // venta sin costo queda fuera de la ganancia junto con su publicidad, igual
  // que su facturación, en vez de restar el gasto sin contar la venta.
  const allocated = await db.query<{ month: string; amount: string | number }>(
    `SELECT to_char(o.date_created, 'YYYY-MM') as month, COALESCE(SUM(oi.ads_cost_allocated), 0) as amount
       FROM order_items oi JOIN orders o ON o.account_id = oi.account_id AND o.id = oi.order_id
      WHERE oi.account_id = $1 AND o.date_created::date BETWEEN $2::date AND $3::date
        AND ${revenueStatusFilter()}
      GROUP BY 1`,
    [accountId, from, to]
  );
  const ivaPaidMonths = new Set<string>();
  if (appliesIva && (await hasColumn(db, "iva_payments", "amount"))) {
    const paid = await db.query<{ month: string }>(
      `SELECT to_char(period, 'YYYY-MM') as month FROM iva_payments WHERE account_id = $1`,
      [accountId]
    );
    for (const r of paid.rows) ivaPaidMonths.add(r.month);
  }
  const charges = (await loadCharges(db, accountId, from, to)).map(toDetail);

  const byMonth = new Map<string, MonthAdjustments & { mlAds: number }>();
  const get = (month: string) => {
    let m = byMonth.get(month);
    if (!m) { m = { month, ...emptyAdjustments(), mlAds: 0 }; byMonth.set(month, m); }
    return m;
  };
  for (const r of ads.rows) {
    const m = get(r.month);
    m.mlAds += Number(r.ml);
    m.adSpend += Number(r.ml) + Number(r.other);
  }
  for (const r of allocated.rows) get(r.month).adsInSales += Number(r.amount);
  for (const c of charges) {
    if (c.treatment !== "subtracted") continue;
    const m = get(c.month);
    if (c.bucket === "full") m.full += c.amount; else m.otherCharges += c.amount;
  }
  for (const inv of await invoiceDiffByMonth(db, accountId, from, to)) {
    const m = get(inv.month);
    m.ordersTotal = inv.ordersTotal;
    m.ordersInvoiced = inv.ordersInvoiced;
    m.invoiceEstimated = inv.estimated;
    m.invoiceBilled = inv.billed;
    m.invoiceDiff = inv.billed - inv.estimated;
    m.refundedOrders = inv.refundedOrders;
    m.refundedRevenue = inv.refundedRevenue;
    m.refundedProfit = inv.refundedProfit;
    m.refundedCosts = inv.refundedCosts;
    m.cancelledCosts = inv.cancelledCosts;
  }

  const out: MonthAdjustments[] = [];
  for (const m of [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month))) {
    // Lo repartido nunca supera lo gastado (redondeos); si lo supera, no se
    // devuelve plata: el ajuste queda en cero.
    m.adsNotInSales = Math.max(0, m.adSpend - m.adsInSales);
    if (appliesIva && !ivaPaidMonths.has(m.month)) {
      // Solo lo que factura Mercado Libre (Mercado Ads sin repartir, Full,
      // otros cargos) trae IVA computable. Meta/Google/TikTok no.
      const mlAdsNotInSales = Math.max(0, m.mlAds - m.adsInSales);
      // La diferencia con la factura también trae IVA: si ML cobró más de lo
      // estimado hay más crédito; si cobró menos, se devuelve el de más.
      m.ivaCredit = ivaFromGross(mlAdsNotInSales + Math.max(0, m.full + m.otherCharges)) + ivaFromGross(m.invoiceDiff + m.refundedCosts + m.cancelledCosts);
    }
    m.total = -m.adsNotInSales - m.full - m.otherCharges - m.invoiceDiff - m.refundedProfit - m.refundedCosts - m.cancelledCosts + m.ivaCredit;
    const { mlAds: _mlAds, ...rest } = m;
    out.push(rest);
  }
  return out;
}

export function sumAdjustments(months: PeriodAdjustments[]): PeriodAdjustments {
  const acc = emptyAdjustments();
  for (const m of months) {
    acc.adSpend += m.adSpend;
    acc.adsInSales += m.adsInSales;
    acc.adsNotInSales += m.adsNotInSales;
    acc.full += m.full;
    acc.otherCharges += m.otherCharges;
    acc.invoiceDiff += m.invoiceDiff;
    acc.ordersTotal += m.ordersTotal;
    acc.ordersInvoiced += m.ordersInvoiced;
    acc.invoiceEstimated += m.invoiceEstimated;
    acc.invoiceBilled += m.invoiceBilled;
    acc.refundedOrders += m.refundedOrders;
    acc.refundedRevenue += m.refundedRevenue;
    acc.refundedProfit += m.refundedProfit;
    acc.refundedCosts += m.refundedCosts;
    acc.cancelledCosts += m.cancelledCosts;
    acc.ivaCredit += m.ivaCredit;
    acc.total += m.total;
  }
  return acc;
}

export async function periodAdjustments(
  db: QueryExecutor,
  accountId: string,
  from: string,
  to: string,
  appliesIva: boolean
): Promise<PeriodAdjustments> {
  return sumAdjustments(await monthlyAdjustments(db, accountId, from, to, appliesIva));
}
