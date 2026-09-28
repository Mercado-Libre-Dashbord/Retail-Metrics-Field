import ExcelJS from "exceljs";
import { NextResponse } from "next/server";
import { withScope } from "@/db/client";
import { hasColumn } from "@/db/schema-capabilities";
import { resolveCurrentAccount } from "@/lib/current-account";
import { revenueStatusFilter } from "@/lib/order-status";
import { recommendAdsAction } from "@/lib/ads-recommendation";

export const runtime = "nodejs";
/** Movimientos puede tener decenas de miles de filas (todo el historial). */
export const maxDuration = 60;

/**
 * Estado financiero para bajar y cruzar a mano: mismos números que Resumen
 * (mismas fuentes — ver comentario de "adSpend" más abajo), agrupados por
 * mes, trimestre, semestre y año, más una hoja base con cada línea de venta
 * y un desglose por producto, todo como Tablas de Excel de verdad (no texto
 * separado por comas) para que se pueda filtrar, ordenar y armar una tabla
 * o gráfico dinámico propio en un par de clics.
 *
 * A propósito trae SIEMPRE todo el historial (no el rango que esté elegido
 * en pantalla): es un estado financiero, no un detalle de un período
 * puntual — para eso ya existe "Descargar detalle del período (CSV)".
 *
 * Nota técnica (no se lo pide nadie, pero explica por qué no hay gráficos ni
 * tablas dinámicas NATIVAS de Excel en el archivo): la librería de Node que
 * arma el .xlsx no sabe escribir esos dos objetos — sí sabe armar Tablas
 * con filtro y fila de totales, y barras de datos dentro de las celdas, que
 * es lo que se usa acá. Con los datos ya en una Tabla, un gráfico o una
 * dinámica de verdad es Insertar → Tabla/Gráfico dinámico en Excel, dos
 * clics sobre esta misma hoja.
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

function addRows(into: Omit<MonthRow, "month">, from: Omit<MonthRow, "month">) {
  into.orders += from.orders;
  into.units += from.units;
  into.revenue += from.revenue;
  into.commission += from.commission;
  into.shipping += from.shipping;
  into.cost += from.cost;
  into.otherTax += from.otherTax;
  into.iva += from.iva;
  into.netProfit += from.netProfit;
  into.adSpend += from.adSpend;
  into.refundOrders += from.refundOrders;
  into.refundAmount += from.refundAmount;
}

/** Agrupa filas mensuales ya calculadas en períodos más largos, sumando cada columna. */
function regroup(monthRows: MonthRow[], granularity: Granularity): { label: string; row: Omit<MonthRow, "month"> }[] {
  const byKey = new Map<string, { label: string; row: Omit<MonthRow, "month"> }>();
  for (const m of monthRows) {
    const { key, label } = periodKey(m.month, granularity);
    const entry = byKey.get(key) ?? { label, row: emptyRow() };
    addRows(entry.row, m);
    byKey.set(key, entry);
  }
  return [...byKey.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => v);
}

const CURRENCY_FMT = '"$" #,##0.00';
const PCT_FMT = "0.0%";
const HEADER_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F2937" } };
const DATA_BAR_COLOR = { argb: "FF638EC6" };

function styleHeaderRow(sheet: ExcelJS.Worksheet) {
  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
  headerRow.fill = HEADER_FILL;
  headerRow.alignment = { vertical: "middle", horizontal: "center" };
}

function addDataBar(sheet: ExcelJS.Worksheet, columnIndex: number, firstDataRow: number, lastDataRow: number) {
  if (lastDataRow < firstDataRow) return;
  const letter = sheet.getColumn(columnIndex).letter;
  sheet.addConditionalFormatting({
    ref: `${letter}${firstDataRow}:${letter}${lastDataRow}`,
    rules: [
      {
        type: "dataBar",
        priority: 1,
        cfvo: [{ type: "min" }, { type: "max" }],
        color: DATA_BAR_COLOR,
      } as ExcelJS.DataBarRuleType,
    ],
  });
}

const PERIOD_COLUMNS: { header: string; key: string; width: number; fmt?: string; sum?: boolean }[] = [
  { header: "Período", key: "label", width: 14 },
  { header: "Órdenes", key: "orders", width: 10, sum: true },
  { header: "Unidades", key: "units", width: 10, sum: true },
  { header: "Facturación bruta", key: "revenue", width: 18, fmt: CURRENCY_FMT, sum: true },
  { header: "Comisión ML", key: "commission", width: 16, fmt: CURRENCY_FMT, sum: true },
  { header: "Envío", key: "shipping", width: 14, fmt: CURRENCY_FMT, sum: true },
  { header: "Publicidad", key: "adSpend", width: 14, fmt: CURRENCY_FMT, sum: true },
  { header: "Costo de producto", key: "cost", width: 18, fmt: CURRENCY_FMT, sum: true },
  { header: "Otros impuestos", key: "otherTax", width: 16, fmt: CURRENCY_FMT, sum: true },
  { header: "IVA", key: "iva", width: 14, fmt: CURRENCY_FMT, sum: true },
  { header: "Ganancia neta", key: "netProfit", width: 16, fmt: CURRENCY_FMT, sum: true },
  { header: "Margen neto", key: "marginPct", width: 12, fmt: PCT_FMT },
  { header: "Órdenes canceladas", key: "refundOrders", width: 16, sum: true },
  { header: "Monto cancelado", key: "refundAmount", width: 16, fmt: CURRENCY_FMT, sum: true },
];

function addPeriodSheet(
  workbook: ExcelJS.Workbook,
  sheetName: string,
  periods: { label: string; row: Omit<MonthRow, "month"> }[]
) {
  const sheet = workbook.addWorksheet(sheetName, { views: [{ state: "frozen", ySplit: 1 }] });

  sheet.addTable({
    name: `Tabla${sheetName}`,
    ref: "A1",
    headerRow: true,
    totalsRow: true,
    style: { theme: "TableStyleMedium9", showRowStripes: true },
    columns: PERIOD_COLUMNS.map((c) => ({
      name: c.header,
      totalsRowFunction: c.sum ? "sum" : undefined,
      totalsRowLabel: c.key === "label" ? "TOTAL" : undefined,
      filterButton: true,
    })),
    rows: periods.map(({ label, row }) => {
      const marginPct = row.revenue > 0 ? row.netProfit / row.revenue : 0;
      return PERIOD_COLUMNS.map((c) => (c.key === "label" ? label : c.key === "marginPct" ? marginPct : (row as Record<string, number>)[c.key]));
    }),
  });

  PERIOD_COLUMNS.forEach((c, i) => {
    const col = sheet.getColumn(i + 1);
    col.width = c.width;
    if (c.fmt) col.numFmt = c.fmt;
  });
  styleHeaderRow(sheet);

  if (periods.length > 0) {
    addDataBar(sheet, PERIOD_COLUMNS.findIndex((c) => c.key === "revenue") + 1, 2, periods.length + 1);
    addDataBar(sheet, PERIOD_COLUMNS.findIndex((c) => c.key === "netProfit") + 1, 2, periods.length + 1);
  }
}

interface ProductRow {
  productId: string;
  title: string;
  orders: number;
  units: number;
  revenue: number;
  commission: number;
  shipping: number;
  adSpend: number;
  cost: number;
  otherTax: number;
  iva: number;
  netProfit: number;
}

const PRODUCT_COLUMNS: { header: string; key: string; width: number; fmt?: string; sum?: boolean }[] = [
  { header: "Producto", key: "title", width: 42 },
  { header: "ID publicación", key: "productId", width: 16 },
  { header: "Órdenes", key: "orders", width: 10, sum: true },
  { header: "Unidades", key: "units", width: 10, sum: true },
  { header: "Facturación bruta", key: "revenue", width: 18, fmt: CURRENCY_FMT, sum: true },
  { header: "Comisión ML", key: "commission", width: 16, fmt: CURRENCY_FMT, sum: true },
  { header: "Envío", key: "shipping", width: 14, fmt: CURRENCY_FMT, sum: true },
  { header: "Publicidad (repartida)", key: "adSpend", width: 18, fmt: CURRENCY_FMT, sum: true },
  { header: "Costo de producto", key: "cost", width: 18, fmt: CURRENCY_FMT, sum: true },
  { header: "Otros impuestos", key: "otherTax", width: 16, fmt: CURRENCY_FMT, sum: true },
  { header: "IVA", key: "iva", width: 14, fmt: CURRENCY_FMT, sum: true },
  { header: "Ganancia neta", key: "netProfit", width: 16, fmt: CURRENCY_FMT, sum: true },
  { header: "Margen neto", key: "marginPct", width: 12, fmt: PCT_FMT },
  { header: "Recomendación de Ads", key: "adsRecommendation", width: 20 },
];

function addProductSheet(workbook: ExcelJS.Workbook, products: ProductRow[]) {
  const sheet = workbook.addWorksheet("Por Producto", { views: [{ state: "frozen", ySplit: 1 }] });

  if (products.length === 0) {
    sheet.addRow(["Todavía no hay ventas sincronizadas para esta cuenta."]);
    return;
  }

  sheet.addTable({
    name: "TablaPorProducto",
    ref: "A1",
    headerRow: true,
    totalsRow: true,
    style: { theme: "TableStyleMedium9", showRowStripes: true },
    columns: PRODUCT_COLUMNS.map((c) => ({
      name: c.header,
      totalsRowFunction: c.sum ? "sum" : undefined,
      totalsRowLabel: c.key === "title" ? "TOTAL" : undefined,
      filterButton: true,
    })),
    rows: products.map((p) => {
      const marginPct = p.revenue > 0 ? p.netProfit / p.revenue : 0;
      // Sin gasto en Ads no hay nada que recomendar — y con "aumentar" acá
      // se prestaría a leerse como "ponele Ads a esto", que no es lo que se
      // quiso decir (ver recommendAdsAction: con adSpend=0 y margen
      // positivo, la cuenta siempre daría "aumentar").
      const adsRecommendation =
        p.adSpend > 0
          ? { pausar: "Pausar", mantener: "Mantener", aumentar: "Aumentar" }[recommendAdsAction(p.netProfit, p.adSpend)]
          : "Sin datos de Ads";
      return PRODUCT_COLUMNS.map((c) =>
        c.key === "marginPct" ? marginPct : c.key === "adsRecommendation" ? adsRecommendation : p[c.key as keyof ProductRow]
      );
    }),
  });

  PRODUCT_COLUMNS.forEach((c, i) => {
    const col = sheet.getColumn(i + 1);
    col.width = c.width;
    if (c.fmt) col.numFmt = c.fmt;
  });
  styleHeaderRow(sheet);
  addDataBar(sheet, PRODUCT_COLUMNS.findIndex((c) => c.key === "revenue") + 1, 2, products.length + 1);
  addDataBar(sheet, PRODUCT_COLUMNS.findIndex((c) => c.key === "netProfit") + 1, 2, products.length + 1);
}

interface MovementRow {
  orderId: string;
  dateCreated: string;
  status: string;
  productId: string;
  productTitle: string;
  quantity: number;
  unitPrice: number;
  mlCommission: number;
  shippingCost: number;
  adsCostAllocated: number;
  costApplied: number | null;
  taxApplied: number | null;
  ivaApplied: number | null;
  netProfit: number | null;
}

const MOVEMENT_COLUMNS: { header: string; key: string; width: number; fmt?: string; sum?: boolean }[] = [
  { header: "Orden", key: "orderId", width: 16 },
  { header: "Fecha", key: "date", width: 12 },
  { header: "Estado", key: "status", width: 12 },
  { header: "ID publicación", key: "productId", width: 16 },
  { header: "Producto", key: "productTitle", width: 42 },
  { header: "Cantidad", key: "quantity", width: 10, sum: true },
  { header: "Precio unitario", key: "unitPrice", width: 14, fmt: CURRENCY_FMT },
  { header: "Facturación", key: "revenue", width: 16, fmt: CURRENCY_FMT, sum: true },
  { header: "Comisión ML", key: "mlCommission", width: 14, fmt: CURRENCY_FMT, sum: true },
  { header: "Envío", key: "shippingCost", width: 12, fmt: CURRENCY_FMT, sum: true },
  { header: "Publicidad", key: "adsCostAllocated", width: 14, fmt: CURRENCY_FMT, sum: true },
  { header: "Costo de producto", key: "cost", width: 16, fmt: CURRENCY_FMT, sum: true },
  { header: "Otros impuestos", key: "tax", width: 14, fmt: CURRENCY_FMT, sum: true },
  { header: "IVA", key: "ivaApplied", width: 12, fmt: CURRENCY_FMT, sum: true },
  { header: "Ganancia neta", key: "netProfit", width: 16, fmt: CURRENCY_FMT, sum: true },
];

function addMovementsSheet(workbook: ExcelJS.Workbook, rows: MovementRow[]) {
  const sheet = workbook.addWorksheet("Movimientos", { views: [{ state: "frozen", ySplit: 1 }] });

  if (rows.length === 0) {
    sheet.addRow(["Todavía no hay ventas sincronizadas para esta cuenta."]);
    return;
  }

  sheet.addTable({
    name: "TablaMovimientos",
    ref: "A1",
    headerRow: true,
    totalsRow: true,
    style: { theme: "TableStyleMedium9", showRowStripes: true },
    columns: MOVEMENT_COLUMNS.map((c) => ({
      name: c.header,
      totalsRowFunction: c.sum ? "sum" : undefined,
      totalsRowLabel: c.key === "orderId" ? "TOTAL" : undefined,
      filterButton: true,
    })),
    rows: rows.map((r) => [
      r.orderId,
      new Date(r.dateCreated).toISOString().slice(0, 10),
      r.status,
      r.productId,
      r.productTitle,
      r.quantity,
      r.unitPrice,
      r.unitPrice * r.quantity,
      r.mlCommission,
      r.shippingCost,
      r.adsCostAllocated,
      r.costApplied === null ? null : r.costApplied * r.quantity,
      r.taxApplied === null ? null : r.taxApplied * r.quantity,
      r.ivaApplied,
      r.netProfit,
    ]),
  });

  MOVEMENT_COLUMNS.forEach((c, i) => {
    const col = sheet.getColumn(i + 1);
    col.width = c.width;
    if (c.fmt) col.numFmt = c.fmt;
  });
  styleHeaderRow(sheet);
}

function addOverviewSheet(
  workbook: ExcelJS.Workbook,
  accountName: string,
  grandTotal: Omit<MonthRow, "month">,
  last12Months: { label: string; row: Omit<MonthRow, "month"> }[]
) {
  const sheet = workbook.addWorksheet("Resumen", { views: [{ showGridLines: false }] });
  sheet.getColumn(1).width = 24;
  sheet.getColumn(2).width = 20;

  sheet.getCell("A1").value = `Estado financiero — ${accountName}`;
  sheet.getCell("A1").font = { bold: true, size: 14 };
  sheet.getCell("A2").value = `Generado el ${new Date().toISOString().slice(0, 10)} · historial completo`;
  sheet.getCell("A2").font = { italic: true, color: { argb: "FF6B7280" } };

  const marginPct = grandTotal.revenue > 0 ? grandTotal.netProfit / grandTotal.revenue : 0;
  const kpis: [string, number, string?][] = [
    ["Facturación bruta", grandTotal.revenue, CURRENCY_FMT],
    ["Órdenes", grandTotal.orders],
    ["Unidades vendidas", grandTotal.units],
    ["Comisión ML", grandTotal.commission, CURRENCY_FMT],
    ["Envío", grandTotal.shipping, CURRENCY_FMT],
    ["Publicidad", grandTotal.adSpend, CURRENCY_FMT],
    ["Costo de producto", grandTotal.cost, CURRENCY_FMT],
    ["Otros impuestos", grandTotal.otherTax, CURRENCY_FMT],
    ["IVA", grandTotal.iva, CURRENCY_FMT],
    ["Ganancia neta", grandTotal.netProfit, CURRENCY_FMT],
    ["Margen neto", marginPct, PCT_FMT],
    ["Órdenes canceladas", grandTotal.refundOrders],
    ["Monto cancelado", grandTotal.refundAmount, CURRENCY_FMT],
  ];

  let row = 4;
  for (const [label, value, fmt] of kpis) {
    sheet.getCell(`A${row}`).value = label;
    sheet.getCell(`A${row}`).font = { bold: true };
    const cell = sheet.getCell(`B${row}`);
    cell.value = value;
    if (fmt) cell.numFmt = fmt;
    row += 1;
  }

  row += 1;
  sheet.getCell(`A${row}`).value = "Últimos 12 meses";
  sheet.getCell(`A${row}`).font = { bold: true, size: 12 };
  row += 1;
  const trendStart = row;
  sheet.getCell(`A${row}`).value = "Mes";
  sheet.getCell(`B${row}`).value = "Facturación bruta";
  sheet.getCell(`C${row}`).value = "Ganancia neta";
  sheet.getRow(row).font = { bold: true };
  row += 1;
  const trendFirstDataRow = row;
  for (const { label, row: r } of last12Months) {
    sheet.getCell(`A${row}`).value = label;
    sheet.getCell(`B${row}`).value = r.revenue;
    sheet.getCell(`B${row}`).numFmt = CURRENCY_FMT;
    sheet.getCell(`C${row}`).value = r.netProfit;
    sheet.getCell(`C${row}`).numFmt = CURRENCY_FMT;
    row += 1;
  }
  sheet.getColumn(3).width = 20;
  if (last12Months.length > 0) {
    const lastDataRow = trendFirstDataRow + last12Months.length - 1;
    sheet.addConditionalFormatting({
      ref: `B${trendFirstDataRow}:B${lastDataRow}`,
      rules: [{ type: "dataBar", priority: 1, cfvo: [{ type: "min" }, { type: "max" }], color: DATA_BAR_COLOR } as ExcelJS.DataBarRuleType],
    });
    sheet.addConditionalFormatting({
      ref: `C${trendFirstDataRow}:C${lastDataRow}`,
      rules: [{ type: "dataBar", priority: 1, cfvo: [{ type: "min" }, { type: "max" }], color: DATA_BAR_COLOR } as ExcelJS.DataBarRuleType],
    });
  }
  void trendStart;
}

export async function GET() {
  const account = await resolveCurrentAccount();
  if (!account) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const { monthRows, products, movements } = await withScope({ accountId: account.id }, async (client) => {
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
    const monthRows = [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));

    // Por producto: la publicidad acá SÍ sale de oi.ads_cost_allocated (la
    // proporción repartida por venta) — ads_spend no tiene granularidad por
    // producto en el modelo actual, así que no hay otra fuente posible.
    const productsResult = await client.query<Record<string, string | number>>(
      `SELECT oi.product_id as "productId", COALESCE(p.title, oi.product_id) as title,
              COUNT(DISTINCT o.id) as orders,
              COALESCE(SUM(oi.quantity), 0) as units,
              COALESCE(SUM(oi.unit_price * oi.quantity), 0) as revenue,
              COALESCE(SUM(oi.ml_commission), 0) as commission,
              COALESCE(SUM(oi.shipping_cost), 0) as shipping,
              COALESCE(SUM(oi.ads_cost_allocated), 0) as "adSpend",
              COALESCE(SUM(oi.cost_applied * oi.quantity), 0) as cost,
              ${hasTax ? "COALESCE(SUM(oi.tax_applied * oi.quantity), 0)" : "0::double precision"} as "otherTax",
              ${hasIva ? "COALESCE(SUM(oi.iva_applied), 0)" : "0::double precision"} as iva,
              COALESCE(SUM(oi.net_profit), 0) as "netProfit"
         FROM order_items oi
         JOIN orders o ON o.account_id = oi.account_id AND o.id = oi.order_id
         LEFT JOIN products p ON p.account_id = oi.account_id AND p.id = oi.product_id
        WHERE oi.account_id = $1 AND ${revenueStatusFilter()}
        GROUP BY oi.product_id, p.title
        ORDER BY "netProfit" DESC`,
      [account.id]
    );
    const products: ProductRow[] = productsResult.rows.map((r) => ({
      productId: String(r.productId),
      title: String(r.title),
      orders: Number(r.orders),
      units: Number(r.units),
      revenue: Number(r.revenue),
      commission: Number(r.commission),
      shipping: Number(r.shipping),
      adSpend: Number(r.adSpend),
      cost: Number(r.cost),
      otherTax: Number(r.otherTax),
      iva: Number(r.iva),
      netProfit: Number(r.netProfit),
    }));

    // Movimientos: a propósito NO filtra por estado (mismo criterio que el
    // CSV) — trae también las canceladas, con su estado en una columna, para
    // que se puedan cotejar contra las anulaciones que el vendedor ya
    // descartó de su lado.
    const movementsResult = await client.query<Record<string, string | number | null>>(
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
        WHERE oi.account_id = $1
        ORDER BY o.date_created, o.id, oi.id`,
      [account.id]
    );
    const movements = movementsResult.rows as unknown as MovementRow[];

    return { monthRows, products, movements };
  });

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Rentabilidad ML";
  workbook.created = new Date();

  const grandTotal = emptyRow();
  for (const m of monthRows) addRows(grandTotal, m);
  const last12Months = regroup(monthRows, "month").slice(-12);

  addOverviewSheet(workbook, account.name, grandTotal, last12Months);

  if (monthRows.length === 0) {
    const sheet = workbook.addWorksheet("Mensual");
    sheet.addRow(["Todavía no hay ventas sincronizadas para esta cuenta."]);
  } else {
    addPeriodSheet(workbook, "Mensual", regroup(monthRows, "month"));
    addPeriodSheet(workbook, "Trimestral", regroup(monthRows, "quarter"));
    addPeriodSheet(workbook, "Semestral", regroup(monthRows, "semester"));
    addPeriodSheet(workbook, "Anual", regroup(monthRows, "year"));
  }
  addProductSheet(workbook, products);
  addMovementsSheet(workbook, movements);

  const buffer = await workbook.xlsx.writeBuffer();
  const today = new Date().toISOString().slice(0, 10);
  return new NextResponse(buffer, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="estado-financiero-${today}.xlsx"`,
    },
  });
}
