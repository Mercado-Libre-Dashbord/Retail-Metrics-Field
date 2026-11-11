import { NextRequest, NextResponse } from "next/server";
import { withScope } from "@/db/client";
import { resolveCurrentAccount } from "@/lib/current-account";
import { invoiceOrders } from "@/sync/period-charges";

export const runtime = "nodejs";

/**
 * La conciliación con la factura de Mercado Libre, venta por venta (CSV):
 * lo que informaba la orden, lo que facturó ML y el ajuste que resulta. Es la
 * forma de chequear el "Ajuste por la factura de ML" del Resumen contra el
 * detalle de cualquier venta en Mercado Libre.
 */
export async function GET(request: NextRequest) {
  const account = await resolveCurrentAccount();
  if (!account) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  const sp = request.nextUrl.searchParams;
  const from = sp.get("from") ?? "1970-01-01";
  const to = sp.get("to") ?? "9999-12-31";
  const rows = await withScope({ accountId: account.id }, (client) => invoiceOrders(client, account.id, from, to));

  const num = (n: number | null) => (n === null ? "" : n.toFixed(2).replace(".", ","));
  const header = [
    "Orden", "Fecha", "Estado", "Facturación",
    "Cargos por vender: informado por la orden", "Cargos por vender: facturado por ML",
    "Envío: informado por la orden", "Envío: facturado por ML", "Ajuste (lo que se resta de más)",
  ];
  const lines = rows.map((r) =>
    [r.orderId, r.date, r.status, num(r.revenue), num(r.feeEstimated), num(r.feeBilled), num(r.shipEstimated), num(r.shipBilled), num(r.adjustment)].join(";")
  );
  // BOM para que Excel abra los acentos bien; ; como separador (configuración regional es-AR).
  const csv = "﻿" + [header.join(";"), ...lines].join("\r\n");
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="conciliacion-factura-ml_${from}_${to}.csv"`,
    },
  });
}
