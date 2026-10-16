/**
 * Importación masiva de costos desde un CSV (por ejemplo, la lista de un
 * proveedor exportada de Excel). Todo acá es puro: el parseo, la detección de
 * columnas y el cruce con los productos se hacen en el navegador para poder
 * mostrar una vista previa antes de tocar nada.
 */

export interface ProductRef {
  id: string;
  title: string;
  sku: string | null;
  currentCost: number | null;
}

export interface ImportRow {
  code: string;
  cost: number;
}

/** Normaliza un código para compararlo: sin espacios de más y en mayúsculas. */
export function normalizeCode(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim().toUpperCase();
}

/** Texto de encabezado sin acentos, espacios ni signos: "Código Art." → "codigoart". */
export function normalizeHeader(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** Lee un número escrito a la argentina ("1.474,59", "$ 1.474,59") o a la inglesa ("1474.59"). */
export function parseAmount(raw: string): number | null {
  let s = raw.replace(/[\s$]|ARS|USD|U\$S/gi, "");
  if (!s) return null;
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma >= 0 && lastDot >= 0) {
    // El separador decimal es el que aparece último.
    s = lastComma > lastDot ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  } else if (lastComma >= 0) {
    s = s.replace(/\./g, "").replace(",", ".");
  } else if (lastDot >= 0) {
    // Un solo punto: si deja exactamente 3 dígitos después y hay más de un
    // grupo, es separador de miles ("1.234.567"); un solo grupo de 3 ("1.234")
    // se interpreta como miles también, es lo habitual en listas de precios.
    const parts = s.split(".");
    const looksLikeThousands = parts.length > 2 || (parts.length === 2 && parts[1].length === 3 && parts[0].length >= 1 && parts[0] !== "0");
    if (looksLikeThousands) s = parts.join("");
  }
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Parsea CSV con separador `,` `;` o tab (se detecta solo) y comillas. */
export function parseCsv(text: string): string[][] {
  const clean = text.replace(/^﻿/, "");
  const firstLines = clean.split(/\r?\n/).slice(0, 15).join("\n");
  const count = (ch: string) => firstLines.split(ch).length - 1;
  const delimiter = [";", "\t", ","].reduce((best, ch) => (count(ch) > count(best) ? ch : best), ",");

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (inQuotes) {
      if (c === '"') {
        if (clean[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === delimiter) { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && clean[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

const CODE_HEADERS = ["codigo", "cod", "sku", "codigoarticulo", "codigoproducto", "codart", "codigointerno"];
const COST_HEADERS = ["costo", "costounitario", "costoneto", "preciocosto", "costounit", "preciodecosto"];

export interface Detected {
  headerRow: number;
  codeCol: number;
  costCol: number;
  headers: string[];
}

function findCol(headers: string[], exact: string[], prefix?: string, exclude?: string): number {
  const norm = headers.map(normalizeHeader);
  for (const name of exact) {
    const i = norm.indexOf(name);
    if (i >= 0) return i;
  }
  if (prefix) {
    const i = norm.findIndex((h) => h.startsWith(prefix) && !(exclude && h.includes(exclude)));
    if (i >= 0) return i;
  }
  return -1;
}

/**
 * Busca la fila de encabezados (no siempre es la primera: las exportaciones de
 * sistemas de stock suelen traer títulos arriba) y las columnas de código y costo.
 */
export function detectColumns(rows: string[][]): Detected | null {
  for (let r = 0; r < Math.min(rows.length, 20); r++) {
    const codeCol = findCol(rows[r], CODE_HEADERS);
    const costCol = findCol(rows[r], COST_HEADERS, "costo", "valsobre");
    if (codeCol >= 0 && costCol >= 0 && codeCol !== costCol) {
      return { headerRow: r, codeCol, costCol, headers: rows[r] };
    }
  }
  return null;
}

export interface ExtractResult {
  rows: ImportRow[];
  /** Filas que no tienen código o no tienen un costo mayor a cero (títulos, rubros, artículos sin costo). */
  skipped: number;
  /** Códigos que aparecen más de una vez con costos distintos: queda el último. */
  duplicates: string[];
}

export function extractRows(rows: string[][], headerRow: number, codeCol: number, costCol: number): ExtractResult {
  const byCode = new Map<string, ImportRow>();
  const duplicates = new Set<string>();
  let skipped = 0;
  for (const r of rows.slice(headerRow + 1)) {
    const code = normalizeCode(r[codeCol]);
    const cost = parseAmount(r[costCol] ?? "");
    if (!code || cost === null || cost <= 0) { skipped++; continue; }
    const prev = byCode.get(code);
    if (prev && prev.cost !== cost) duplicates.add(code);
    byCode.set(code, { code, cost });
  }
  return { rows: [...byCode.values()], skipped, duplicates: [...duplicates] };
}

export interface PreviewItem {
  code: string;
  cost: number;
  products: ProductRef[];
}

export interface Preview {
  /** Costos que cambian algo. */
  toUpdate: PreviewItem[];
  /** El producto ya tiene exactamente ese costo. */
  unchanged: PreviewItem[];
  /** Códigos del archivo que no coinciden con ningún producto. */
  notFound: ImportRow[];
}

/** Cruza el archivo con el catálogo por SKU (o por ID de publicación). Un SKU puede estar en varias publicaciones. */
export function buildPreview(rows: ImportRow[], products: ProductRef[]): Preview {
  const byCode = new Map<string, ProductRef[]>();
  for (const p of products) {
    for (const key of [normalizeCode(p.sku), normalizeCode(p.id)]) {
      if (!key) continue;
      const list = byCode.get(key) ?? [];
      if (!list.includes(p)) list.push(p);
      byCode.set(key, list);
    }
  }
  const preview: Preview = { toUpdate: [], unchanged: [], notFound: [] };
  for (const row of rows) {
    const matches = byCode.get(row.code);
    if (!matches || matches.length === 0) { preview.notFound.push(row); continue; }
    const changing = matches.filter((p) => p.currentCost === null || Math.abs(p.currentCost - row.cost) >= 0.005);
    if (changing.length === 0) preview.unchanged.push({ ...row, products: matches });
    else preview.toUpdate.push({ ...row, products: changing });
  }
  return preview;
}
