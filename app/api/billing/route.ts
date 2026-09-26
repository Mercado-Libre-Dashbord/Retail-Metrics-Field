import { NextRequest, NextResponse } from "next/server";
import { withScope } from "@/db/client";
import { hasColumn } from "@/db/schema-capabilities";
import { resolveCurrentAccount } from "@/lib/current-account";
import { classifyCharge, BUCKET_LABEL, type ChargeBucket } from "@/sync/billing";
import { appliesIva } from "@/db/accounts";

export const runtime = "nodejs";

interface ChargeRow {
  orderId: string | null;
  concept: string | null;
  detailType: string | null;
  detailSubType: string | null;
  amount: number;
}

export interface CommissionCheck {
  /** Órdenes con cargo de comisión facturado Y líneas de venta en la app. */
  orders: number;
  billed: number;
  calculated: number;
  /** Facturado ÷ calculado. ~1 = coincide; ~1,21 = ML suma IVA encima. */
  ratio: number;
  multiUnitOrders: number;
  multiUnitRatio: number | null;
  /** Monotributo/exento: el IVA de la factura de ML no se recupera, es costo. */
  ivaIsCost: boolean;
}

/**
 * Lo que Mercado Libre efectivamente facturó en el período, agrupado por
 * concepto. Es el número "de verdad" contra el que conciliar lo que la app
 * estima orden por orden.
 */
export async function GET(request: NextRequest) {
  const account = await resolveCurrentAccount();
  if (!account) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const { searchParams } = request.nextUrl;
  const from = searchParams.get("from") ?? "1970-01-01";
  const to = searchParams.get("to") ?? "9999-12-31";

  const data = await withScope({ accountId: account.id }, async (client) => {
    // La tabla llega por migración manual; sin ella se devuelve vacío en vez
    // de romper la página (ver db/schema-capabilities.ts).
    if (!(await hasColumn(client, "billing_charges", "detail_id"))) {
      return { available: false, buckets: [], total: 0 };
    }

    const result = await client.query<ChargeRow>(
      `SELECT order_id as "orderId", concept, detail_type as "detailType", detail_sub_type as "detailSubType", amount
       FROM billing_charges
       WHERE account_id = $1 AND (charged_at IS NULL OR charged_at::date BETWEEN $2::date AND $3::date)`,
      [account.id, from, to]
    );

    const totals = new Map<ChargeBucket, number>();
    for (const row of result.rows) {
      const bucket = classifyCharge(row.concept, row.detailType, row.detailSubType);
      totals.set(bucket, (totals.get(bucket) ?? 0) + Number(row.amount));
    }

    const buckets = [...totals.entries()]
      .map(([bucket, amount]) => ({ bucket, label: BUCKET_LABEL[bucket], amount }))
      .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));

    // Conciliación orden por orden de la comisión: lo que ML facturó por cada
    // orden contra lo que la app descontó para esa MISMA orden. Comparar
    // totales del período mezcla fechas (ML factura cuando cobra, la app
    // cuenta cuando se vende); orden por orden la comparación es exacta, y
    // contesta con datos reales si ML factura la comisión con IVA encima.
    const billedByOrder = new Map<string, number>();
    for (const row of result.rows) {
      if (!row.orderId || classifyCharge(row.concept, row.detailType, row.detailSubType) !== "comision") continue;
      billedByOrder.set(row.orderId, (billedByOrder.get(row.orderId) ?? 0) + Math.abs(Number(row.amount)));
    }
    let commissionCheck: CommissionCheck | null = null;
    if (billedByOrder.size > 0) {
      const ours = await client.query<{ orderId: string; commission: number; multiUnit: boolean }>(
        `SELECT order_id as "orderId", SUM(ml_commission) as commission, bool_or(quantity > 1) as "multiUnit"
           FROM order_items WHERE account_id = $1 AND order_id = ANY($2::text[])
          GROUP BY order_id`,
        [account.id, [...billedByOrder.keys()]]
      );
      let billed = 0, calculated = 0, billedMulti = 0, calculatedMulti = 0, multiOrders = 0;
      for (const r of ours.rows) {
        const b = billedByOrder.get(String(r.orderId)) ?? 0;
        const c = Number(r.commission);
        billed += b;
        calculated += c;
        if (r.multiUnit) {
          billedMulti += b;
          calculatedMulti += c;
          multiOrders += 1;
        }
      }
      if (ours.rows.length > 0 && calculated > 0) {
        commissionCheck = {
          orders: ours.rows.length,
          billed,
          calculated,
          ratio: billed / calculated,
          multiUnitOrders: multiOrders,
          multiUnitRatio: calculatedMulti > 0 ? billedMulti / calculatedMulti : null,
          ivaIsCost: !appliesIva(account.taxCondition),
        };
      }
    }

    return {
      available: true,
      commissionCheck,
      buckets,
      total: buckets.reduce((sum, b) => sum + b.amount, 0),
      charges: result.rows.length,
    };
  });

  return NextResponse.json(data);
}
