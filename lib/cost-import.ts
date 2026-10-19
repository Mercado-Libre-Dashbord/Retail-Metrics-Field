/**
 * Importación masiva de costos desde la planilla del vendedor (CSV o Excel,
 * por ejemplo su control de stock). Todo acá es puro: la detección de
 * columnas y el cruce con los productos se hacen en el navegador para mostrar
 * una vista previa antes de tocar nada. El Excel se lee en el servidor
 * (/api/products/import-costs/parse) y llega acá como filas de celdas.
 */

export type Cell = string | number | null;

export interface ProductRef {
  id: string;
  title: string;
  sku: string | null;
  /** SKU de la publicación y de cada variante (migración 023). */
  skus?: string[];
  /** EAN/GTIN de la publicación y de sus variantes (migración 023). */
  gtins?: string[];
  currentCost: number | null;
}

export interface ImportRow {
  /** Código ya normalizado para cruzar ("" si la fila no trae). */
  code: string;
  /** Código tal como figura en la planilla, para mostrarlo. */
  rawCode: string;
  ean: string | null;
  name: string | null;
  cost: number;
}

const cellText = (v: Cell | undefined) => (v === null || v === undefined ? "" : String(v));

/**
 * Normaliza un código para compararlo: sin espacios de más, en mayúsculas y
 * sin puntos al final. En planillas de stock es común que "BNFW50." y "BNFW50"
 * sean el mismo artículo de dos despachos de importación distintos.
 */
export function normalizeCode(value: string | number | null | undefined): string {
  return cellText(value ?? null).replace(/\s+/g, " ").trim().toUpperCase().replace(/\.+$/, "");
}

/** Un EAN válido: 8 a 14 dígitos. Excel a veces lo guarda como número. */
export function normalizeEan(value: Cell | undefined): string | null {
  const s = cellText(value ?? null).trim().replace(/\.0+$/, "");
  return /^\d{8,14}$/.test(s) ? s : null;
}

/** Texto de encabezado sin acentos, espacios ni signos: "Código Art." → "codigoart". */
export function normalizeHeader(value: Cell | undefined): string {
  return cellText(value ?? null)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** Lee un número escrito a la argentina ("1.474,59", "$ 1.474,59") o a la inglesa ("1474.59"). */
export function parseAmount(raw: Cell | undefined): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  let s = cellText(raw ?? null).replace(/[\s$]|ARS|USD|U\$S/gi, "");
  if (!s) return null;
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma >= 0 && lastDot >= 0) {
    // El separador decimal es el que aparece último.
    s = lastComma > lastDot ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  } else if (lastComma >= 0) {
    s = s.replace(/\./g, "").replace(",", ".");
  } else if (lastDot >= 0) {
    // Un solo punto con exactamente 3 dígitos después ("1.234"), o varios
    // puntos ("1.234.567"), es separador de miles: es lo habitual en listas
    // de precios en pesos.
    const parts = s.split(".");
    const looksLikeThousands = parts.length > 2 || (parts.length === 2 && parts[1].length === 3 && parts[0] !== "0");
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
const EAN_HEADERS = ["ean", "eanxunidad", "gtin", "codigodebarras", "codbarras", "ean13", "upc"];
const NAME_HEADERS = ["articulo", "descripcion", "producto", "nombre", "detalle"];

export interface Detected {
  headerRow: number;
  codeCol: number;
  costCol: number;
  /** -1 si la planilla no tiene columna de EAN. */
  eanCol: number;
  /** -1 si no hay columna de descripción. */
  nameCol: number;
}

function findCol(headers: Cell[], exact: string[], prefix?: string, exclude?: string): number {
  const norm = headers.map((h) => normalizeHeader(h));
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
 * Busca la fila de encabezados (no siempre es la primera: las planillas de
 * stock suelen traer títulos y fechas arriba) y las columnas que interesan.
 */
export function detectColumns(rows: Cell[][]): Detected | null {
  for (let r = 0; r < Math.min(rows.length, 30); r++) {
    const codeCol = findCol(rows[r], CODE_HEADERS);
    const costCol = findCol(rows[r], COST_HEADERS, "costo", "valsobre");
    if (codeCol >= 0 && costCol >= 0 && codeCol !== costCol) {
      return {
        headerRow: r,
        codeCol,
        costCol,
        eanCol: findCol(rows[r], EAN_HEADERS),
        nameCol: findCol(rows[r], NAME_HEADERS),
      };
    }
  }
  return null;
}

export interface Columns {
  codeCol: number;
  costCol: number;
  eanCol: number;
  nameCol: number;
}

export interface ExtractResult {
  rows: ImportRow[];
  /** Filas sin código ni EAN, o sin un costo mayor a cero (títulos, rubros, totales, artículos sin costo). */
  skipped: number;
  /** Artículos que aparecen más de una vez con costos distintos: queda el último. */
  duplicates: string[];
}

export function extractRows(rows: Cell[][], headerRow: number, cols: Columns): ExtractResult {
  const byKey = new Map<string, ImportRow>();
  const duplicates = new Set<string>();
  let skipped = 0;
  for (const r of rows.slice(headerRow + 1)) {
    const rawCode = cellText(r[cols.codeCol] ?? null).trim();
    const code = normalizeCode(rawCode);
    const ean = cols.eanCol >= 0 ? normalizeEan(r[cols.eanCol]) : null;
    const cost = parseAmount(r[cols.costCol]);
    if ((!code && !ean) || cost === null || cost <= 0) { skipped++; continue; }
    const key = code || `EAN:${ean}`;
    const prev = byKey.get(key);
    if (prev && Math.abs(prev.cost - cost) >= 0.005) duplicates.add(rawCode || ean!);
    const name = cols.nameCol >= 0 ? cellText(r[cols.nameCol] ?? null).trim() || null : null;
    byKey.set(key, { code, rawCode, ean: ean ?? prev?.ean ?? null, name: name ?? prev?.name ?? null, cost });
  }
  return { rows: [...byKey.values()], skipped, duplicates: [...duplicates] };
}

export type MatchedBy = "ean" | "sku";

export interface PreviewItem extends ImportRow {
  products: ProductRef[];
  by: MatchedBy;
}

export interface Conflict {
  product: ProductRef;
  /** Las filas de la planilla que pedían costos distintos para la misma publicación; se usó la primera. */
  rows: ImportRow[];
}

export interface Preview {
  /** Costos que cambian algo. */
  toUpdate: PreviewItem[];
  /** La publicación ya tiene exactamente ese costo. */
  unchanged: PreviewItem[];
  /** Artículos de la planilla que no coinciden con ninguna publicación. */
  notFound: ImportRow[];
  conflicts: Conflict[];
  /** Publicaciones que van a seguir sin costo después de importar: lo que queda para cargar a mano. */
  stillWithoutCost: ProductRef[];
}

function index(products: ProductRef[], keysOf: (p: ProductRef) => string[]): Map<string, ProductRef[]> {
  const map = new Map<string, ProductRef[]>();
  for (const p of products) {
    for (const key of keysOf(p)) {
      if (!key) continue;
      const list = map.get(key) ?? [];
      if (!list.includes(p)) list.push(p);
      map.set(key, list);
    }
  }
  return map;
}

/**
 * Cruza la planilla con las publicaciones: primero por EAN (el código de
 * barras es único y no depende de cómo cargó el SKU), y si no, por SKU o ID de
 * publicación. Un mismo artículo puede estar en varias publicaciones.
 */
export function buildPreview(rows: ImportRow[], products: ProductRef[]): Preview {
  const byEan = index(products, (p) => (p.gtins ?? []).map((g) => normalizeEan(g) ?? ""));
  const byCode = index(products, (p) => [p.sku, ...(p.skus ?? []), p.id].map((c) => normalizeCode(c)));

  const assigned = new Map<string, { cost: number; row: ImportRow }>();
  const conflicts = new Map<string, Conflict>();
  const preview: Preview = { toUpdate: [], unchanged: [], notFound: [], conflicts: [], stillWithoutCost: [] };

  for (const row of rows) {
    let by: MatchedBy = "ean";
    let matches = row.ean ? byEan.get(row.ean) : undefined;
    if (!matches?.length) {
      by = "sku";
      matches = row.code ? byCode.get(row.code) : undefined;
    }
    if (!matches?.length) { preview.notFound.push(row); continue; }

    const mine: ProductRef[] = [];
    for (const p of matches) {
      const prev = assigned.get(p.id);
      if (!prev) { assigned.set(p.id, { cost: row.cost, row }); mine.push(p); continue; }
      if (Math.abs(prev.cost - row.cost) >= 0.005) {
        const c = conflicts.get(p.id) ?? { product: p, rows: [prev.row] };
        c.rows.push(row);
        conflicts.set(p.id, c);
      }
    }
    if (mine.length === 0) continue;
    const changing = mine.filter((p) => p.currentCost === null || Math.abs(p.currentCost - row.cost) >= 0.005);
    if (changing.length > 0) preview.toUpdate.push({ ...row, products: changing, by });
    if (changing.length < mine.length) preview.unchanged.push({ ...row, products: mine.filter((p) => !changing.includes(p)), by });
  }

  preview.conflicts = [...conflicts.values()];
  preview.stillWithoutCost = products.filter((p) => p.currentCost === null && !assigned.has(p.id));
  return preview;
}
