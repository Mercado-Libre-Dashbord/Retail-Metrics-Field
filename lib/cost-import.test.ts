import { describe, it, expect } from "vitest";
import { parseAmount, parseCsv, detectColumns, extractRows, buildPreview, normalizeCode } from "./cost-import";

describe("parseAmount", () => {
  it.each([
    ["1.474,59", 1474.59],
    ["$ 737,29", 737.29],
    ["1.791.814,00", 1791814],
    ["1546", 1546],
    ["737.29", 737.29],
    ["1,234.56", 1234.56],
    ["0.5", 0.5],
  ])("%s", (raw, expected) => expect(parseAmount(raw)).toBe(expected));
  it("devuelve null con texto o vacío", () => {
    expect(parseAmount("")).toBeNull();
    expect(parseAmount("abc")).toBeNull();
  });
});

const FILE = [
  "CODIGO;UXB;EAN;ARTICULO;UNIDADES;BULTOS;VAL SOBRE PRC VTA;VAL SOBRE COSTO;PRECIO LISTA;COSTO",
  "HOGAR: COCINA;;;;;;;;;",
  ";;;DEPOSITO GENERAL;;;;;;",
  '02509ST/BHA6;48;6950182205608;"VASO 310 ML. (24017IC03000499V-CH)";0;0,00;-;-;1.474,59;737,29',
  "04612ST/BHA6;48;6950182205639;VASO 400 ML.;60;1,25;107.400,00;53.700,00;1.790,00;895,00",
  "1;48;7781840500136;JARRO BOMBE;1.159;24,15;2.598.130,30;1.791.814,00;2.241,70;1.546,00",
].join("\n");

describe("importación del archivo de Lucas", () => {
  const rows = parseCsv(FILE);
  it("encuentra encabezado y columnas, sin confundir 'VAL SOBRE COSTO' con COSTO", () => {
    const d = detectColumns(rows)!;
    expect(d.headerRow).toBe(0);
    expect(d.codeCol).toBe(0);
    expect(d.costCol).toBe(9);
  });
  it("detecta el encabezado aunque haya títulos arriba", () => {
    const d = detectColumns([["Lista de precios"], [""], ...rows])!;
    expect(d.headerRow).toBe(2);
  });
  it("lee los costos unitarios y salta rubros y títulos", () => {
    const d = detectColumns(rows)!;
    const r = extractRows(rows, d.headerRow, d.codeCol, d.costCol);
    expect(r.rows).toEqual([
      { code: "02509ST/BHA6", cost: 737.29 },
      { code: "04612ST/BHA6", cost: 895 },
      { code: "1", cost: 1546 },
    ]);
    expect(r.skipped).toBe(2);
  });
  it("cruza por SKU y por ID de publicación, y separa cambios, iguales y no encontrados", () => {
    const products = [
      { id: "MLA1", title: "Vaso 310", sku: "02509st/bha6", currentCost: null },
      { id: "MLA2", title: "Vaso 400", sku: "04612ST/BHA6", currentCost: 895 },
      { id: "MLA3", title: "Vaso 400 azul", sku: "04612ST/BHA6", currentCost: 700 },
    ];
    const p = buildPreview([{ code: "02509ST/BHA6", cost: 737.29 }, { code: "04612ST/BHA6", cost: 895 }, { code: "ZZZ", cost: 5 }], products);
    expect(p.toUpdate.map((x) => x.products.map((y) => y.id))).toEqual([["MLA1"], ["MLA3"]]);
    expect(p.unchanged).toHaveLength(0);
    expect(p.notFound).toEqual([{ code: "ZZZ", cost: 5 }]);
  });
  it("avisa los códigos repetidos con costos distintos", () => {
    const r = extractRows([["codigo", "costo"], ["A", "10"], ["A", "12"]], 0, 0, 1);
    expect(r.rows).toEqual([{ code: "A", cost: 12 }]);
    expect(r.duplicates).toEqual(["A"]);
    expect(normalizeCode("  ab  c ")).toBe("AB C");
  });
});
