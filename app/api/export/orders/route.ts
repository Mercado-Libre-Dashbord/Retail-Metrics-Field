import { NextRequest, NextResponse } from "next/server";
import { withScope } from "@/db/client";
import { hasColumn } from "@/db/schema-capabilities";
import { resolveCurrentAccount } from "@/lib/current-account";

export const runtime = "nodejs";

/**
 * Detalle línea por línea de lo que el panel usó para calcular la ganancia,
 * en CSV.
 *
 * Existe para que un cliente pueda cruzar nuestros números contra su propia
 * contabilidad sin tener que confiar a ciegas en el total agregado — el
 * primer cliente que lo hizo con esta herramienta encontró un error real de
 * cálculo (el IVA no correspondía a su régimen) en minutos.
 *
 * A propósito NO filtra por estado: trae también las órdenes canceladas, con
 * su estado en una columna, para que se puedan cotejar contra las
 * anulaciones que el propio vendedor ya excluyó de su lado.
 */
function csvCell(value: string | number | null): string {
  if (value === null) return "";
  let s = String(value);
  // Un texto que empieza con = + - @ (o tab/retorno) Excel lo ejecuta como
  // fórmula al abrir el CSV: un título de publicación tipo
  // "=HYPERLINK(...)" se volvería un link o un cálculo. Se le antepone un
  // apóstrofo para que quede como texto. Solo a textos: un número negativo
  // tiene que seguir siendo número.
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function GET(request: NextRequest) {
  const account = await resolveCurrentAccount();
  if (!account) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const { searchParams } = request.nextUrl;
  const from = searchParams.get("from") ?? "1970-01-01";
  const to = searchParams.get("to") ?? "9999-12-31";

  const rows = await withScope({ accountId: account.id }, async (client) => {
    const hasTax = await hasColumn(client, "order_items", "tax_applied");
    const hasIva = await hasColumn(client, "order_items", "iva_applied");
    const hasThumb = await hasColumn(client, "products", "thumbnail");

    const result = await client.query(
      `SELECT o.id as "orderId", o.date_created as "dateCreated", o.status as "status",
              oi.product_id as "productId", COALESCE(p.title, oi.product_id) as "productTitle",
              oi.quantity as "quantity", oi.unit_price as "unitPrice",
              oi.ml_commission as "mlCommission", oi.shipping_cost as "shippingCost",
              oi.ads_cost_allocated as "adsCostAllocated", oi.cost_applied as "costApplied",
              ${hasTax ? "oi.tax_applied" : "NULL::double precision"} as "taxApplied",
              ${hasIva ? "oi.iva_applied" : "NULL::double precision"} as "ivaApplied",
              oi.net_profit as "netProfit"
         FROM order_items oi
         JOIN orders o ON o.account_id = oi.account_id AND o.id = oi.order_id
         LEFT JOIN products p ON p.account_id = oi.account_id AND p.id = oi.product_id
        WHERE oi.account_id = $1 AND o.date_created::date BETWEEN $2::date AND $3::date
        ORDER BY o.date_created, o.id, oi.id`,
      [account.id, from, to]
    );
    void hasThumb;
    return result.rows as {
      orderId: string; dateCreated: string; status: string; productId: string; productTitle: string;
      quantity: number; unitPrice: number; mlCommission: number; shippingCost: number;
      adsCostAllocated: number; costApplied: number | null; taxApplied: number | null;
      ivaApplied: number | null; netProfit: number | null;
    }[];
  });

  const header = [
    "orden", "fecha", "estado", "id_producto", "producto", "cantidad", "precio_unitario",
    "facturacion", "comision_ml", "envio", "publicidad", "costo_producto", "otros_impuestos",
    "iva", "ganancia_neta",
  ];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(
      [
        csvCell(r.orderId),
        csvCell(new Date(r.dateCreated).toISOString().slice(0, 10)),
        csvCell(r.status),
        csvCell(r.productId),
        csvCell(r.productTitle),
        csvCell(r.quantity),
        csvCell(r.unitPrice),
        csvCell(r.unitPrice * r.quantity),
        csvCell(r.mlCommission),
        csvCell(r.shippingCost),
        csvCell(r.adsCostAllocated),
        csvCell(r.costApplied === null ? null : r.costApplied * r.quantity),
        csvCell(r.taxApplied === null ? null : r.taxApplied * r.quantity),
        csvCell(r.ivaApplied),
        csvCell(r.netProfit),
      ].join(",")
    );
  }
  // BOM UTF-8: sin esto, Excel en Windows abre las tildes como caracteres
  // sueltos en vez de detectar UTF-8 solo.
  const csv = "﻿" + lines.join("\n") + "\n";

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="detalle-ventas-${from}-a-${to}.csv"`,
    },
  });
}
