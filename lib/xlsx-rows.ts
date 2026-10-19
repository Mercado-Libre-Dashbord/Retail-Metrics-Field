import ExcelJS from "exceljs";
import type { Cell } from "@/lib/cost-import";

const MAX_ROWS = 20000;
const MAX_COLS = 80;

export interface SheetRows {
  sheets: string[];
  sheet: string;
  rows: Cell[][];
  /** Primera fecha que aparece arriba de la hoja (las planillas de stock suelen traer la fecha de corte), en YYYY-MM-DD. */
  fileDate: string | null;
}

function toCell(value: ExcelJS.CellValue): { cell: Cell; date?: Date } {
  if (value === null || value === undefined) return { cell: null };
  if (typeof value === "number") return { cell: value };
  if (typeof value === "string") return { cell: value };
  if (typeof value === "boolean") return { cell: value ? "SI" : "NO" };
  if (value instanceof Date) return { cell: value.toISOString().slice(0, 10), date: value };
  const v = value as { result?: unknown; richText?: { text: string }[]; text?: unknown; error?: unknown };
  if ("result" in v) return toCell((v.result ?? null) as ExcelJS.CellValue);
  if (Array.isArray(v.richText)) return { cell: v.richText.map((t) => t.text).join("") };
  if (typeof v.text === "string") return { cell: v.text };
  return { cell: null };
}

/**
 * Lee UNA hoja de un Excel como filas de celdas (texto o número), con los
 * resultados de las fórmulas. No lee ni devuelve las demás hojas: una planilla
 * de stock puede traer, por ejemplo, una hoja con datos de los clientes del
 * vendedor, que no necesitamos.
 */
export async function readSheetRows(data: ArrayBuffer, sheetName?: string | null): Promise<SheetRows> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data);
  const sheets = wb.worksheets.map((w) => w.name);
  if (sheets.length === 0) throw new Error("El archivo no tiene hojas.");
  const preferred = sheetName && sheets.includes(sheetName) ? sheetName : sheets.find((s) => s.trim().toUpperCase() === "STOCK") ?? sheets[0];
  const ws = wb.getWorksheet(preferred)!;

  const rows: Cell[][] = [];
  let fileDate: string | null = null;
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rows.length >= MAX_ROWS) return;
    const out: Cell[] = [];
    const count = Math.min(row.cellCount, MAX_COLS);
    for (let c = 1; c <= count; c++) {
      const { cell, date } = toCell(row.getCell(c).value);
      if (date && !fileDate && rowNumber <= 6) fileDate = cell as string;
      out.push(cell);
    }
    while (out.length && out[out.length - 1] === null) out.pop();
    if (out.length) rows.push(out);
  });
  return { sheets, sheet: preferred, rows, fileDate };
}
