import ExcelJS from "exceljs";
import { NextResponse } from "next/server";
import { withScope } from "@/db/client";
import { hasColumn } from "@/db/schema-capabilities";
import { resolveCurrentAccount } from "@/lib/current-account";
import { revenueStatusFilter } from "@/lib/order-status";

export const runtime = "nodejs";

/**
 * Estado financiero para bajar y cruzar a mano: mismos números que Resumen
 * (mismas fuentes — ver comentario de "adSpend" más abajo), pero agrupados
 * por mes, trimestre, semestre y año en un solo archivo, para no tener que
 * ir período por período apretando el selector de fechas.
 *
 * A propósito trae SIEMPRE todo el historial (no el rango que esté elegido
 * en pantalla): es un estado financiero, no un detalle de un período
 * puntual — para eso ya existe "Descargar detalle del período (CSV)".
 */

interface MonthRow {
  month: string; // "YYYY-MM"
  orders: number;
  units: number;
  revenue: number;
  commission: number;
  shipping: number;
  cost: number;
  otherTax: number;
  iva: number;
  netProfit: number;
  adSpend: number;
  refundOrders: number;
  refundAmount: number;
}

const MONTH_NAMES = [
  "Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic",
];

function monthLabel(month: string): string {
  const [year, m] = month.split("-");
  return `${MONTH_NAMES[Number(m) - 1]} ${year}`;
}

type Granularity = "month" | "quarter" | "semester" | "year";

/** A qué período cae un mes "YYYY-MM", según la granularidad pedida. */
function periodKey(month: string, granularity: Granularity): { key: string; label: string } {
  const [year, m] = month.split("-");
  const monthNum = Number(m);
  if (granularity === "month") return { key: month, label: monthLabel(month) };
  if (granularity === "quarter") {
    const q = Math.ceil(monthNum / 3);
    return { key: `${year}-T${q}`, label: `T${q} ${year}` };
  }
  if (granularity === "semester") {
    const s = monthNum <= 6 ? 1 : 2;
    return { key: `${year}-S${s}`, label: `S${s} ${year}` };
  }
  return { key: year, label: year };
}

function emptyRow(): Omit<MonthRow, "month"> {
  return {
    orders: 0, units: 0, revenue: 0, commission: 0, shipping: 0, cost: 0,
    otherTax: 0, iva: 0, netProfit: 0, adSpend: 0, refundOrders: 0, refundAmount: 0,
  };
}

/** Agrupa filas mensuales ya calculadas en períodos más largos, sumando cada columna. */
function regroup(monthRows: MonthRow[], granularity: Granularity): { label: string; row: Omit<MonthRow, "month"> }[] {
  const byKey = new Map<string, { label: string; row: Omit<MonthRow, "month"> }>();
  for (const m of monthRows) {
    const { key, label } = periodKey(m.month, granularity);
    const entry = byKey.get(key) ?? { label, row: emptyRow() };
    entry.row.orders += m.orders;
    entry.row.units += m.units;
    entry.row.revenue += m.revenue;
    entry.row.commission += m.commission;
    entry.row.shipping += m.shipping;
    entry.row.cost += m.cost;
    entry.row.otherTax += m.otherTax;
    entry.row.iva += m.iva;
    entry.row.netProfit += m.netProfit;
    entry.row.adSpend += m.adSpend;
    entry.row.refundOrders += m.refundOrders;
    entry.row.refundAmount += m.refundAmount;
    byKey.set(key, entry);
  }
  return [...byKey.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => v);
}

const CURRENCY_FMT = '"$" #,##0.00';
const PCT_FMT = "0.0%";

const COLUMNS: { header: string; key: string; width: number; fmt?: string }[] = [
  { header: "Período", key: "label", width: 14 },
  { header: "Órdenes", key: "orders", width: 10 },
  { header: "Unidades", key: "units", width: 10 },
  { header: "Facturación bruta", key: "revenue", width: 18, fmt: CURRENCY_FMT },
  { header: "Comisión ML", key: "commission", width: 16, fmt: CURRENCY_FMT },
  { header: "Envío", key: "shipping", width: 14, fmt: CURRENCY_FMT },
  { header: "Publicidad", key: "adSpend", width: 14, fmt: CURRENCY_FMT },
  { header: "Costo de producto", key: "cost", width: 18, fmt: CURRENCY_FMT },
  { header: "Otros impuestos", key: "otherTax", width: 16, fmt: CURRENCY_FMT },
  { header: "IVA", key: "iva", width: 14, fmt: CURRENCY_FMT },
  { header: "Ganancia neta", key: "netProfit", width: 16, fmt: CURRENCY_FMT },
  { header: "Margen neto", key: "marginPct", width: 12, fmt: PCT_FMT },
  { header: "Órdenes canceladas", key: "refundOrders", width: 16 },
  { header: "Monto cancelado", key: "refundAmount", width: 16, fmt: CURRENCY_FMT },
];

function addPeriodSheet(
  workbook: ExcelJS.Workbook,
  sheetName: string,
  periods: { label: string; row: Omit<MonthRow, "month"> }[]
) {
  const sheet = workbook.addWorksheet(sheetName, { views: [{ state: "frozen", ySplit: 1 }] });
  sheet.columns = COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));

  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
  headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F2937" } };
  headerRow.alignment = { vertical: "middle", horizontal: "center" };

  const totals = emptyRow();
  for (const { label, row } of periods) {
    const marginPct = row.revenue > 0 ? row.netProfit / row.revenue : 0;
    sheet.addRow({ label, ...row, marginPct });
    totals.orders += row.orders;
    totals.units += row.units;
    totals.revenue += row.revenue;
    totals.commission += row.commission;
    totals.shipping += row.shipping;
    totals.cost += row.cost;
    totals.otherTax += row.otherTax;
    totals.iva += row.iva;
    totals.netProfit += row.netProfit;
    totals.adSpend += row.adSpend;
    totals.refundOrders += row.refundOrders;
    totals.refundAmount += row.refundAmount;
  }

  const totalMarginPct = totals.revenue > 0 ? totals.netProfit / totals.revenue : 0;
  const totalRow = sheet.addRow({ label: "TOTAL", ...totals, marginPct: totalMarginPct });
  totalRow.font = { bold: true };
  totalRow.border = { top: { style: "thin" } };

  for (const col of COLUMNS) {
    if (!col.fmt) continue;
    const excelCol = sheet.getColumn(col.key);
    excelCol.numFmt = col.fmt;
  }
  sheet.getColumn("label").alignment = { horizontal: "left" };
}

export async function GET() {
  const account = await resolveCurrentAccount();
  if (!account) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const monthRows = await withScope({ accountId: account.id }, async (client) => {
    const hasTax = await hasColumn(client, "order_items", "tax_applied");
    const hasIva = await hasColumn(client, "order_items", "iva_applied");

    const salesResult = await client.query<Record<string, string | number>>(
      `SELECT to_char(o.date_created, 'YYYY-MM') as month,
              COUNT(DISTINCT o.id) as orders,
              COALESCE(SUM(oi.quantity), 0) as units,
              COALESCE(SUM(oi.unit_price * oi.quantity), 0) as revenue,
              COALESCE(SUM(oi.ml_commission), 0) as commission,
              COALESCE(SUM(oi.shipping_cost), 0) as shipping,
              COALESCE(SUM(oi.cost_applied * oi.quantity), 0) as cost,
              ${hasTax ? "COALESCE(SUM(oi.tax_applied * oi.quantity), 0)" : "0::double precision"} as "otherTax",
              ${hasIva ? "COALESCE(SUM(oi.iva_applied), 0)" : "0::double precision"} as iva,
              COALESCE(SUM(oi.net_profit), 0) as "netProfit"
         FROM order_items oi
         JOIN orders o ON o.account_id = oi.account_id AND o.id = oi.order_id
        WHERE oi.account_id = $1 AND ${revenueStatusFilter()}
        GROUP BY month`,
      [account.id]
    );

    const refundsResult = await client.query<Record<string, string | number>>(
      `SELECT to_char(o.date_created, 'YYYY-MM') as month,
              COUNT(DISTINCT o.id) as "refundOrders",
              COALESCE(SUM(oi.unit_price * oi.quantity), 0) as "refundAmount"
         FROM order_items oi
         JOIN orders o ON o.account_id = oi.account_id AND o.id = oi.order_id
        WHERE oi.account_id = $1 AND NOT (${revenueStatusFilter()})
        GROUP BY month`,
      [account.id]
    );

    // Mismo criterio que /api/summary: el gasto en Ads del estado financiero
    // sale de ads_spend directo (todo lo cargado), no de sumar
    // oi.ads_cost_allocated — para que coincida con la tarjeta "Costos en
    // Ads" de Resumen en vez de un número distinto que obligue a explicar
    // por qué no cierran entre sí.
    const adsResult = await client.query<Record<string, string | number>>(
      `SELECT to_char(date, 'YYYY-MM') as month, COALESCE(SUM(amount), 0) as "adSpend"
         FROM ads_spend WHERE account_id = $1
        GROUP BY month`,
      [account.id]
    );

    const byMonth = new Map<string, MonthRow>();
    const get = (month: string) => {
      let row = byMonth.get(month);
      if (!row) {
        row = { month, ...emptyRow() };
        byMonth.set(month, row);
      }
      return row;
    };
    for (const r of salesResult.rows) {
      const row = get(String(r.month));
      row.orders = Number(r.orders);
      row.units = Number(r.units);
      row.revenue = Number(r.revenue);
      row.commission = Number(r.commission);
      row.shipping = Number(r.shipping);
      row.cost = Number(r.cost);
      row.otherTax = Number(r.otherTax);
      row.iva = Number(r.iva);
      row.netProfit = Number(r.netProfit);
    }
    for (const r of refundsResult.rows) {
      const row = get(String(r.month));
      row.refundOrders = Number(r.refundOrders);
      row.refundAmount = Number(r.refundAmount);
    }
    for (const r of adsResult.rows) {
      const row = get(String(r.month));
      row.adSpend = Number(r.adSpend);
    }

    return [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));
  });

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Rentabilidad ML";
  workbook.created = new Date();

  if (monthRows.length === 0) {
    // Sin ventas todavía: un archivo vacío sin ninguna fila es más confuso
    // que uno con las columnas y un aviso, sobre todo si se abre semanas
    // después sin acordarse de por qué no tiene datos.
    const sheet = workbook.addWorksheet("Mensual");
    sheet.addRow(["Todavía no hay ventas sincronizadas para esta cuenta."]);
  } else {
    addPeriodSheet(workbook, "Mensual", regroup(monthRows, "month"));
    addPeriodSheet(workbook, "Trimestral", regroup(monthRows, "quarter"));
    addPeriodSheet(workbook, "Semestral", regroup(monthRows, "semester"));
    addPeriodSheet(workbook, "Anual", regroup(monthRows, "year"));
  }

  const buffer = await workbook.xlsx.writeBuffer();
  const today = new Date().toISOString().slice(0, 10);
  return new NextResponse(buffer, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="estado-financiero-${today}.xlsx"`,
    },
  });
}
