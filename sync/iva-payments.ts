import type { QueryExecutor } from "@/db/client";
import { hasColumn } from "@/db/schema-capabilities";
import { revenueStatusFilter } from "@/lib/order-status";
import { IVA_RATE } from "@/lib/iva";

/**
 * IVA real cargado por el vendedor (el que le pasó su contador), mes por mes.
 *
 * El cálculo teórico (21%: débito − crédito, ver lib/iva.ts) no coincide con
 * lo que un vendedor termina pagando: percepciones, compras sin factura A,
 * otros créditos. Cuando el vendedor carga cuánto pagó en un mes, el % de IVA
 * efectivo de ese mes es IVA pagado ÷ facturación del mes, y cada venta del
 * mes lleva ese % de su facturación como IVA — así la suma de las ventas del
 * mes da exactamente lo pagado. Los meses sin monto usan el % del último mes
 * cargado anterior (o, si no hay ninguno anterior, del primero cargado):
 * es la mejor estimación que hay de lo que va a pagar.
 *
 * Una cuenta que nunca cargó un monto no se toca: sigue con el cálculo
 * teórico, igual que antes de esta función.
 */

/** Mes contable de una orden: en hora argentina, no en UTC (una venta del
 * 31 a las 22 h es del mes que termina, no del siguiente). */
export const ORDER_MONTH_SQL = `date_trunc('month', o.date_created AT TIME ZONE 'America/Argentina/Buenos_Aires')::date`;

export interface IvaMonth {
  /** "YYYY-MM" */
  period: string;
  revenue: number;
  /** IVA cargado por el vendedor para ese mes, o null si no cargó. */
  paid: number | null;
  /** % efectivo del mes cargado (pagado ÷ facturación), o null. */
  effectiveRate: number | null;
  /** IVA que hoy tienen aplicado las ventas del mes (cargado, estimado o teórico). */
  applied: number;
}

export async function ivaPaymentsAvailable(db: QueryExecutor): Promise<boolean> {
  return hasColumn(db, "iva_payments", "amount");
}

/**
 * Recalcula el IVA de las ventas según los montos cargados y ajusta la
 * ganancia neta por la diferencia (la ganancia ya tiene restado el IVA
 * anterior). Sin montos cargados no hace nada, salvo `force` (se acaba de
 * borrar el último monto: hay que volver al cálculo teórico).
 *
 * `productId` limita la escritura a un producto (después de recalcular ese
 * producto); el % se calcula siempre con la facturación de toda la cuenta.
 */
export async function applyIvaPayments(
  db: QueryExecutor,
  accountId: string,
  opts: { productId?: string; force?: boolean } = {}
): Promise<number> {
  if (!(await ivaPaymentsAvailable(db)) || !(await hasColumn(db, "order_items", "iva_applied"))) return 0;
  if (!opts.force) {
    const any = await db.query(`SELECT 1 FROM iva_payments WHERE account_id = $1 LIMIT 1`, [accountId]);
    if (any.rows.length === 0) return 0;
  }

  const factor = IVA_RATE / (1 + IVA_RATE);
  const params: unknown[] = [accountId, factor];
  if (opts.productId) params.push(opts.productId);

  const result = await db.query(
    `WITH monthly AS (
       SELECT ${ORDER_MONTH_SQL} AS period, SUM(oi.unit_price * oi.quantity) AS revenue
         FROM order_items oi JOIN orders o ON o.account_id = oi.account_id AND o.id = oi.order_id
        WHERE oi.account_id = $1 AND ${revenueStatusFilter()}
        GROUP BY 1
     ),
     rates AS (
       SELECT p.period, p.amount / m.revenue AS rate
         FROM iva_payments p JOIN monthly m ON m.period = p.period
        WHERE p.account_id = $1 AND m.revenue > 0
     ),
     month_rate AS (
       SELECT m.period,
              COALESCE(
                (SELECT r.rate FROM rates r WHERE r.period <= m.period ORDER BY r.period DESC LIMIT 1),
                (SELECT r.rate FROM rates r ORDER BY r.period ASC LIMIT 1)
              ) AS rate
         FROM monthly m
     ),
     calc AS (
       SELECT oi.id,
              COALESCE(oi.iva_applied, 0) AS old_iva,
              CASE WHEN mr.rate IS NOT NULL THEN oi.unit_price * oi.quantity * mr.rate
                   ELSE (oi.unit_price * oi.quantity - COALESCE(oi.ml_commission, 0) - COALESCE(oi.shipping_cost, 0)
                         - COALESCE(oi.ads_cost_allocated, 0) - COALESCE(oi.cost_applied, 0) * oi.quantity) * $2
              END AS new_iva
         FROM order_items oi
         JOIN orders o ON o.account_id = oi.account_id AND o.id = oi.order_id
         LEFT JOIN month_rate mr ON mr.period = ${ORDER_MONTH_SQL}
        WHERE oi.account_id = $1 AND ${revenueStatusFilter()}${opts.productId ? " AND oi.product_id = $3" : ""}
     )
     UPDATE order_items oi
        SET iva_applied = c.new_iva,
            net_profit = CASE WHEN oi.net_profit IS NULL THEN NULL ELSE oi.net_profit + c.old_iva - c.new_iva END
       FROM calc c
      WHERE oi.id = c.id AND oi.account_id = $1 AND abs(c.new_iva - c.old_iva) > 0.005
      RETURNING oi.id`,
    params
  );
  return result.rows.length;
}

/** Facturación, IVA cargado e IVA aplicado de los últimos `months` meses
 * (más cualquier mes viejo que tenga un monto cargado). */
export async function listIvaMonths(db: QueryExecutor, accountId: string, months = 12): Promise<IvaMonth[]> {
  const available = await ivaPaymentsAvailable(db);
  const result = await db.query<{ period: string | Date; revenue: number; applied: number; paid: number | null }>(
    `WITH monthly AS (
       SELECT ${ORDER_MONTH_SQL} AS period,
              SUM(oi.unit_price * oi.quantity) AS revenue,
              SUM(COALESCE(oi.iva_applied, 0)) AS applied
         FROM order_items oi JOIN orders o ON o.account_id = oi.account_id AND o.id = oi.order_id
        WHERE oi.account_id = $1 AND ${revenueStatusFilter()}
        GROUP BY 1
     ),
     paid AS (${available ? "SELECT period, amount FROM iva_payments WHERE account_id = $1" : "SELECT NULL::date AS period, NULL::double precision AS amount WHERE false"})
     SELECT COALESCE(m.period, p.period) AS period, COALESCE(m.revenue, 0) AS revenue,
            COALESCE(m.applied, 0) AS applied, p.amount AS paid
       FROM monthly m FULL JOIN paid p ON p.period = m.period
      WHERE p.amount IS NOT NULL
         OR m.period >= (date_trunc('month', now() AT TIME ZONE 'America/Argentina/Buenos_Aires') - ($2::int - 1) * interval '1 month')::date
      ORDER BY 1 DESC`,
    [accountId, months]
  );
  return result.rows.map((r) => {
    const d = new Date(r.period);
    const revenue = Number(r.revenue);
    const paid = r.paid === null ? null : Number(r.paid);
    return {
      period: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`,
      revenue,
      paid,
      effectiveRate: paid !== null && revenue > 0 ? paid / revenue : null,
      applied: Number(r.applied),
    };
  });
}

export async function saveIvaPayment(db: QueryExecutor, accountId: string, period: string, amount: number | null): Promise<void> {
  const date = `${period}-01`;
  if (amount === null) {
    await db.query(`DELETE FROM iva_payments WHERE account_id = $1 AND period = $2::date`, [accountId, date]);
  } else {
    await db.query(
      `INSERT INTO iva_payments (account_id, period, amount, updated_at) VALUES ($1, $2::date, $3, now())
       ON CONFLICT (account_id, period) DO UPDATE SET amount = EXCLUDED.amount, updated_at = now()`,
      [accountId, date, amount]
    );
  }
}
