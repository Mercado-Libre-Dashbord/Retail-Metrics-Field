import { describe, it, expect } from "vitest";
import { parseAmount, parseCsv, detectColumns, extractRows, buildPreview, normalizeCode, normalizeEan, namesMatch, detectPackUnits, selectedByDefault, suggestByName, type Cell } from "./cost-import";

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
  it("usa los números de Excel tal cual (sin reinterpretar puntos)", () => expect(parseAmount(12.345)).toBe(12.345));
  it("devuelve null con texto o vacío", () => {
    expect(parseAmount("")).toBeNull();
    expect(parseAmount("COSTO")).toBeNull();
    expect(parseAmount(null)).toBeNull();
  });
});

describe("normalización de códigos", () => {
  it("une los códigos con punto final (otro despacho del mismo artículo)", () => {
    expect(normalizeCode("BNFW50.")).toBe(normalizeCode("bnfw50"));
    expect(normalizeCode("  ab  c ")).toBe("AB C");
  });
  it("acepta EAN como texto o número y descarta guiones y textos", () => {
    expect(normalizeEan(7798353739823)).toBe("7798353739823");
    expect(normalizeEan("6950182205639")).toBe("6950182205639");
    expect(normalizeEan("-")).toBeNull();
    expect(normalizeEan("CONTENEDOR")).toBeNull();
  });
});

// Misma forma que una planilla de stock real: títulos y fecha arriba, el
// encabezado repetido en cada familia, filas de rubro y de totales, y el mismo
// artículo en dos despachos ("PLATO." y "PLATO").
const SHEET: Cell[][] = [
  ["CODIGO", "UXB", "EAN", "ARTICULO", "DEPOSITO A", "DEPOSITO B", "BULTOS", "VAL SOBRE PRC VTA", "VAL SOBRE COSTO", null, "ACTUAL", "ACTUAL"],
  [null, null, null, "2026-10-09", null, null, null, null, null, null, "LP0011", "COSTO"],
  [null, null, null, "STOCK EXISTENTE"],
  ["CODIGO", "UXB", "EAN", "ARTICULO", "UNIDADES", "UNIDADES", "BULTOS", "VAL SOBRE PRC VTA", "VAL SOBRE COSTO", null, "PRECIO LISTA", "COSTO"],
  ["OTROS"],
  ["B4", 12, "-", "INSECTICIDA X 250 GR", 1847, "0", 153.9, 2770500, 1910684.56, null, 1500, 1034.48],
  ["EDC", 9, "-", "ESTUFA", 0, "0", 0, 0, 0, null, 12257.01, 0],
  [null, null, null, "TOTALES FAMILIA OTROS:", 6954, 0, 422.5, 3575163.87, 2465624.63],
  ["CODIGO", "UXB", "EAN", "ARTICULO", "UNIDADES", "UNIDADES", "BULTOS", "VAL SOBRE PRC VTA", "VAL SOBRE COSTO", null, "PRECIO LISTA", "COSTO"],
  ["HOGAR: COCINA", null, null, "DEPOSITO GENERAL"],
  ["PLATO110", 24, "7790000000011", "PLATO PLAYO (DESPACHO 1)", 1008, "0", 42, 0, 0, null, 3090, 1545],
  ["PLATO110.", 24, 7790000000011, "PLATO PLAYO (DESPACHO 2)", 35, "0", 1, 0, 0, null, 3090, 1545],
  ["1", 48, 7790000000028, "JARRO GRIS 330 CC", 1159, "0", 24.15, 0, 0, null, 2241.7, 1546],
];

describe("planilla de stock", () => {
  const d = detectColumns(SHEET)!;
  it("encuentra el encabezado debajo de los títulos, sin confundir VAL SOBRE COSTO con COSTO", () => {
    expect(d).toEqual({ headerRow: 3, codeCol: 0, costCol: 11, eanCol: 2, nameCol: 3 });
  });
  it("lee un artículo por código, une los despachos y salta rubros, totales, encabezados repetidos y costos en cero", () => {
    const r = extractRows(SHEET, d.headerRow, d);
    expect(r.rows.map((x) => [x.code, x.ean, x.cost])).toEqual([
      ["B4", null, 1034.48],
      ["PLATO110", "7790000000011", 1545],
      ["1", "7790000000028", 1546],
    ]);
    expect(r.duplicates).toEqual([]);
  });
  it("cruza primero por EAN, después por SKU (de la publicación o de una variante) o ID", () => {
    const r = extractRows(SHEET, d.headerRow, d);
    const products = [
      { id: "MLA1", title: "Insecticida Power Bait 250 gr", sku: null, skus: ["b4"], gtins: [], currentCost: null },
      { id: "MLA2", title: "Plato Playo Ceramica", sku: "OTRO-SKU", skus: [], gtins: ["7790000000011"], currentCost: 1545 },
      { id: "MLA3", title: "Jarro Gris Mug", sku: null, skus: [], gtins: ["7790000000028"], currentCost: 1200 },
      { id: "MLA4", title: "Sin códigos", sku: null, skus: [], gtins: [], currentCost: null },
    ];
    const p = buildPreview(r.rows, products);
    expect(p.items.map((x) => [x.row.code, x.product.id, x.by, x.nameOk])).toEqual([
      ["B4", "MLA1", "sku", true],
      ["PLATO110", "MLA2", "ean", true],
      ["1", "MLA3", "ean", true],
    ]);
    expect(p.notFound).toEqual([]);
    expect(p.stillWithoutCost.map((x) => x.id)).toEqual(["MLA4"]);
  });

  it("no aplica sin revisar un cruce por código con nombres que no tienen nada que ver (EAN reutilizado)", () => {
    const row = { code: "21", rawCode: "21", ean: "7797483002678", name: "JARRO BOMBE RAYADO VERDE PASTEL", cost: 1612.74 };
    const p = buildPreview([row], [
      { id: "MLA7", title: "Fibras Fibrones Marcadores Plumones X 80 Doble Punta Multicolor", sku: null, gtins: ["7797483002678"], currentCost: null },
    ]);
    expect(p.items[0].nameOk).toBe(false);
    expect(selectedByDefault(p.items[0])).toBe(false);
  });

  it("marca conflicto cuando dos artículos con costos distintos caen en la misma publicación, y no aplica ninguno solo", () => {
    const products = [{ id: "MLA9", title: "Combo Jarro y Taza", sku: "X", gtins: ["7790000000028"], currentCost: null }];
    const p = buildPreview(
      [
        { code: "X", rawCode: "X", ean: null, name: "Jarro", cost: 10 },
        { code: "Y", rawCode: "Y", ean: "7790000000028", name: "Taza", cost: 20 },
      ],
      products
    );
    expect(p.items.map((x) => x.conflict)).toEqual([true, true]);
    expect(p.items.some(selectedByDefault)).toBe(false);
  });
  it("avisa los artículos repetidos con costos distintos", () => {
    const r = extractRows([["codigo", "costo"], ["A", "10"], ["A.", "12"]], 0, { codeCol: 0, costCol: 1, eanCol: -1, nameCol: -1 });
    expect(r.rows.map((x) => x.cost)).toEqual([12]);
    expect(r.duplicates).toEqual(["A."]);
  });
});

describe("CSV", () => {
  it("detecta ; y lee importes argentinos", () => {
    const rows = parseCsv('CODIGO;EAN;ARTICULO;COSTO\n02509ST/BHA6;6950182205608;"VASO 310 ML.";737,29\n');
    const d = detectColumns(rows)!;
    expect(extractRows(rows, d.headerRow, d).rows).toEqual([
      { code: "02509ST/BHA6", rawCode: "02509ST/BHA6", ean: "6950182205608", name: "VASO 310 ML.", cost: 737.29 },
    ]);
  });
});

describe("namesMatch", () => {
  it.each([
    ["BOYA CHICA", "Boya Dosificadora De Cloro Para Pileta", true],
    ["BASE MULTIFUNCIONAL CON RUEDAS (26017IC06000031X-CH)", "Base Móvil Con 4 Ruedas Adaptable Heladera", true],
    ["JARRO BOMBE GRIS PASTEL 330 CC", "Set X6 Jarro Liso Mug Taza De Cerámica", true],
    ["JARRO BOMBE BEIGE PASTEL 330 CC", "Escobilla Cepillo Baño Limpia Inodoro Con Tapa Bambu", false],
    ["PERCHAS TERCIOPELO NEGRAS", "Perchas Negras Percha Terciopelo Pack De 20 Unidades", true],
  ])("%s / %s", (a, t, ok) => expect(namesMatch(a, t)).toBe(ok));
});

describe("detectPackUnits", () => {
  it.each([
    ["Set X6 Jarro Liso Mug Taza De Cerámica", "JARRO BOMBE GRIS PASTEL 330 CC", 6],
    ["Perchas Negras Percha Terciopelo Pack De 20 Unidades Color Negro", "PERCHA TERCIOPELO", 20],
    ["X6 Unidades Jarros Submarino Cafe Vaso Vidrio 285ml", "VASO SUBMARINO", 6],
    ["Hormiguicida En Polvo X 250 Gr Power Bait", "HORMIGUICIDA EN POLVO X 250 GR.", 1],
    ["Set X 3 Botellas Motivacionales", "SET X 3 BOTELLAS MOTIVACIONALES AS", 1],
    ["Boya Dosificadora De Cloro Para Pileta", "BOYA CHICA", 1],
    ["Fibras Marcadores X 80 Doble Punta", "FIBRAS X 80", 1],
    ["Perchas Negras Percha Terciopelo Pack De 20 Unidades", "PERCHA PARA ROPA DE TERCIOPELO X10 (26017IC05)", 2],
    ["Pack X 15 Perchas", "PERCHA X10", 1],
  ])("%s → %i", (title, article, n) => expect(detectPackUnits(title, article)).toBe(n));
});

describe("suggestByName", () => {
  const rows = [
    { code: "JM3816", rawCode: "JM3816.", ean: null, name: "TERMOMETRO DIGITAL P/COMIDAS (26017IC06000789F)", cost: 1495 },
    { code: "BAL1", rawCode: "BAL1", ean: null, name: "BALANZA DE COCINA DIGITAL", cost: 3000 },
    { code: "BNFW90", rawCode: "BNFW90.", ean: null, name: "ENSALADERA 22,5 CM. (26017IC06000598D)", cost: 1595 },
    { code: "BNFW75", rawCode: "BNFW75.", ean: null, name: "ENSALADERA 19 CM.", cost: 1195 },
    { code: "WR10", rawCode: "WR6553-10", ean: null, name: "PERCHA PARA ROPA DE TERCIOPELO X10", cost: 4000 },
  ];
  const p = (title: string) => ({ id: title, title, sku: null, currentCost: null });

  it("sugiere el artículo más parecido y usa las medidas para desempatar", () => {
    const s = suggestByName(rows, [p("Termómetro Digital Para Comidas Cocina Pinche"), p("Ensaladera 22,5 Cm Cuadrada Negra")]);
    expect(s.map((x) => x.row.code)).toEqual(["JM3816", "BNFW90"]);
    expect(s.every((x) => x.by === "name" && !selectedByDefault(x))).toBe(true);
  });

  it("ajusta las unidades cuando el artículo ya es un pack", () => {
    const [s] = suggestByName(rows, [p("Perchas Negras Percha Terciopelo Pack De 20 Unidades")]);
    expect(s.row.code).toBe("WR10");
    expect(s.packUnits).toBe(2);
  });

  it("no sugiere nada si no hay palabras en común", () => {
    expect(suggestByName(rows, [p("Auriculares Bluetooth Inalambricos Gamer")])).toEqual([]);
  });

  it("buildPreview agrega las sugerencias solo para publicaciones sin costo que no cruzaron por código", () => {
    const prev = buildPreview(rows, [
      { id: "A", title: "Termómetro Digital Para Comidas", sku: "JM3816", currentCost: null },
      { id: "B", title: "Ensaladera 22,5 Cm", sku: null, currentCost: null },
      { id: "C", title: "Ensaladera 19 Cm", sku: null, currentCost: 900 },
    ]);
    expect(prev.items.map((x) => [x.product.id, x.by])).toEqual([["A", "sku"], ["B", "name"]]);
    expect(prev.stillWithoutCost).toEqual([]);
  });
});
