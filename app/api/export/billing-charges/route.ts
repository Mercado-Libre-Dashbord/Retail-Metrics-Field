import { NextRequest, NextResponse } from "next/server";
import { withScope } from "@/db/client";
import { hasColumn } from "@/db/schema-capabilities";
import { resolveCurrentAccount } from "@/lib/current-account";
import { BUCKET_LABEL, MANUAL_DETAIL_TYPE, classifyCharge } from "@/sync/billing";
import { CHARGE_DATE_SQL, SIGNED_AMOUNT_SQL } from "@/sync/period-charges";

export const runtime = "nodejs";

const HOW: Record<string, string> = {
  venta: "Dentro de la venta: reemplaza la comisión o el envío que informaba la orden",
  ads: "No se resta desde la factura: la publicidad se resta desde Mercado Ads",
  resta: "Se resta de la ganancia del período",
  impuesto: "No se resta: pago a cuenta de impuestos",
};

/**
 * Cada cargo de la factura de Mercado Libre del período, uno por fila (CSV),
 * con su identificador, la factura (mes) a la que pertenece, la venta a la que
 * está atado y cómo lo cuenta la ganancia neta. Para constatar contra la
 * factura que nada falte ni se cuente dos veces.
 */
export async function GET(request: NextRequest) {
  const account = await resolveCurrentAccount();
  if (!account) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  const sp = request.nextUrl.searchParams;
  const from = sp.get("from") ?? "1970-01-01";
  const to = sp.get("to") ?? "9999-12-31";

  const rows = await withScope({ accountId: account.id }, async (client) => {
    if (!(await hasColumn(client, "billing_charges", "detail_id"))) return [];
    const r = await client.query<{ detail_id: string; period_key: string | null; date: string; concept: string | null; detail_type: string | null; detail_sub_type: string | null; order_id: string | null; signed: string | number }>(
      `SELECT detail_id, period_key, to_char(${CHARGE_DATE_SQL}, 'YYYY-MM-DD') as date, concept, detail_type, detail_sub_type, order_id,
              ${SIGNED_AMOUNT_SQL} as signed
         FROM billing_charges
        WHERE account_id = $1 AND ${CHARGE_DATE_SQL} BETWEEN $2::date AND $3::date
        ORDER BY ${CHARGE_DATE_SQL}, detail_id
        LIMIT 200000`,
      [account.id, from, to]
    );
    return r.rows;
  });

  const num = (n: number) => n.toFixed(2).replace(".", ",");
  const clean = (v: string | null) => (v ?? "").replace(/[;\r\n]+/g, " ").trim();
  const header = ["Id del cargo", "Fecha", "Factura (mes)", "Concepto", "Tipo", "Código", "Grupo", "Orden", "Importe (anulaciones en negativo)", "Cómo se cuenta en la ganancia neta"];
  const lines = rows.map((r) => {
    const manual = r.detail_type === MANUAL_DETAIL_TYPE;
    const bucket = classifyCharge(r.concept, r.detail_type, r.detail_sub_type);
    const linked = Boolean(r.order_id);
    const how =
      bucket === "bonificacion_flex" ? "Se suma a la ganancia: ingresa directo a Mercado Pago" :
      bucket === "impuesto" ? HOW.impuesto :
      bucket === "publicidad" ? (/products? ads/i.test(r.concept ?? "") || manual ? HOW.ads : HOW.resta) :
      linked && !manual ? HOW.venta :
      bucket === "comision" || bucket === "envio" ? "No se resta: ya está en cada venta" : HOW.resta;
    return [
      clean(r.detail_id), r.date, clean(r.period_key), manual ? "Cargado a mano" : clean(r.concept), clean(r.detail_type), clean(r.detail_sub_type),
      BUCKET_LABEL[bucket], clean(r.order_id), num(Number(r.signed)), how,
    ].join(";");
  });
  const csv = "﻿" + [header.join(";"), ...lines].join("\r\n");
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="cargos-factura-ml_${from}_${to}.csv"`,
    },
  });
}
