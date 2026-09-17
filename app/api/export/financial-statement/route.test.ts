import { describe, it, expect, vi, beforeEach } from "vitest";
import ExcelJS from "exceljs";

vi.mock("@/db/client", () => ({ withScope: vi.fn() }));
vi.mock("@/lib/current-account", () => ({ resolveCurrentAccount: vi.fn() }));

import { GET } from "./route";
import { withScope } from "@/db/client";
import { resolveCurrentAccount } from "@/lib/current-account";
import { resetColumnCache } from "@/db/schema-capabilities";

const account = {
  id: "acc1", name: "C", ownerEmail: "a@b.com", mlSellerId: "S1",
  otherTaxRate: 0, taxCondition: "responsable_inscripto" as const, taxConditionConfirmed: true, createdAt: "2026-01-01",
};

async function loadWorkbook(res: Response): Promise<ExcelJS.Workbook> {
  const buffer = await res.arrayBuffer();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as any);
  return wb;
}

function mockQuery(data: {
  sales?: Record<string, string | number>[];
  refunds?: Record<string, string | number>[];
  ads?: Record<string, string | number>[];
  products?: Record<string, string | number>[];
  movements?: Record<string, string | number | null>[];
}) {
  return vi.fn().mockImplementation(async (sql: string) => {
    if (sql.includes("information_schema.columns")) {
      return { rows: [{ table_name: "order_items", column_name: "tax_applied" }, { table_name: "order_items", column_name: "iva_applied" }] };
    }
    // Marcadores únicos por consulta.
    if (sql.includes("FROM ads_spend")) return { rows: data.ads ?? [] };
    if (sql.includes("NOT (o.status NOT IN")) return { rows: data.refunds ?? [] };
    if (sql.includes("GROUP BY oi.product_id")) return { rows: data.products ?? [] };
    if (sql.includes("ORDER BY o.date_created, o.id, oi.id")) return { rows: data.movements ?? [] };
    return { rows: data.sales ?? [] };
  });
}

/** El total de un TableColumn con totalsRowFunction:"sum" es una fórmula SUBTOTAL, no un número ya calculado. */
function expectSubtotalFormula(cell: ExcelJS.Cell, tableName: string, columnName: string) {
  expect(cell.value).toMatchObject({ formula: expect.stringContaining(`SUBTOTAL(109,${tableName}[${columnName}])`) });
}

describe("GET /api/export/financial-statement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetColumnCache();
    vi.mocked(resolveCurrentAccount).mockResolvedValue(account);
  });

  it("returns 401 with no active account", async () => {
    vi.mocked(resolveCurrentAccount).mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
  });

  it("sets xlsx headers", async () => {
    vi.mocked(withScope).mockImplementation((ctx: any, fn: any) => fn({ query: mockQuery({}) }));

    const res = await GET();

    expect(res.headers.get("Content-Type")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(res.headers.get("Content-Disposition")).toContain("estado-financiero-");
    expect(res.headers.get("Content-Disposition")).toContain(".xlsx");
  });

  it("adds placeholder sheets when the account has no sales yet", async () => {
    vi.mocked(withScope).mockImplementation((ctx: any, fn: any) => fn({ query: mockQuery({}) }));

    const wb = await loadWorkbook(await GET());

    expect(wb.worksheets.map((s) => s.name)).toEqual(["Resumen", "Mensual", "Por Producto", "Movimientos"]);
  });

  it("builds Mensual/Trimestral/Semestral/Anual sheets, aggregating months correctly into each period", async () => {
    // Dos meses del mismo trimestre y semestre (marzo y mayo 2026), y otro en
    // un año distinto (2025), para que se vea que trimestre/semestre/año
    // suman los meses que corresponden y no todo junto.
    const query = mockQuery({
      sales: [
        { month: "2026-03", orders: 2, units: 3, revenue: 1000, commission: 100, shipping: 50, cost: 300, otherTax: 10, iva: 42, netProfit: 498 },
        { month: "2026-05", orders: 1, units: 1, revenue: 500, commission: 65, shipping: 30, cost: 150, otherTax: 5, iva: 21, netProfit: 229 },
        { month: "2025-11", orders: 1, units: 1, revenue: 200, commission: 26, shipping: 10, cost: 60, otherTax: 2, iva: 8, netProfit: 94 },
      ],
      refunds: [{ month: "2026-03", refundOrders: 1, refundAmount: 400 }],
      ads: [
        { month: "2026-03", adSpend: 80 },
        { month: "2026-05", adSpend: 20 },
      ],
    });
    vi.mocked(withScope).mockImplementation((ctx: any, fn: any) => fn({ query }));

    const wb = await loadWorkbook(await GET());

    expect(wb.worksheets.map((s) => s.name)).toEqual([
      "Resumen", "Mensual", "Trimestral", "Semestral", "Anual", "Por Producto", "Movimientos",
    ]);

    const resumen = wb.getWorksheet("Resumen")!;
    // Fila 4 en adelante: KPIs en orden — Facturación bruta es el primero.
    expect(resumen.getCell("A4").value).toBe("Facturación bruta");
    expect(resumen.getCell("B4").value).toBe(1700); // 1000 + 500 + 200, la única celda de Resumen que es un número plano (no fórmula de Tabla)

    const mensual = wb.getWorksheet("Mensual")!;
    // Fila 1 encabezado, luego los 3 meses ordenados cronológicamente, luego TOTAL.
    expect(mensual.getRow(2).getCell("A").value).toBe("Nov 2025");
    expect(mensual.getRow(3).getCell("A").value).toBe("Mar 2026");
    expect(mensual.getRow(3).getCell("D").value).toBe(1000); // revenue
    expect(mensual.getRow(3).getCell("G").value).toBe(80); // adSpend
    expect(mensual.getRow(3).getCell("M").value).toBe(1); // refundOrders
    expect(mensual.getRow(3).getCell("N").value).toBe(400); // refundAmount
    expect(mensual.getRow(4).getCell("A").value).toBe("May 2026");
    const total = mensual.getRow(5);
    expect(total.getCell("A").value).toBe("TOTAL");
    expectSubtotalFormula(total.getCell("D"), "TablaMensual", "Facturación bruta");

    const trimestral = wb.getWorksheet("Trimestral")!;
    // T1 2026 junta marzo (T1); T2 2026 junta mayo (T2, abr-jun); T4 2025 junta noviembre.
    const trimestreLabels = [2, 3, 4].map((r) => trimestral.getRow(r).getCell("A").value);
    expect(trimestreLabels).toEqual(["T4 2025", "T1 2026", "T2 2026"]);
    const t1Row = trimestral.getRow(3);
    expect(t1Row.getCell("D").value).toBe(1000);
    expect(t1Row.getCell("G").value).toBe(80);

    const semestral = wb.getWorksheet("Semestral")!;
    const semestreLabels = [2, 3].map((r) => semestral.getRow(r).getCell("A").value);
    expect(semestreLabels).toEqual(["S2 2025", "S1 2026"]);
    // Marzo y mayo caen ambos en S1 2026: se suman en la MISMA fila, no en dos.
    expect(semestral.rowCount).toBe(1 + 2 + 1); // encabezado + (S2 2025, S1 2026) + TOTAL
    const s1_2026 = semestral.getRow(3);
    expect(s1_2026.getCell("A").value).toBe("S1 2026");
    expect(s1_2026.getCell("D").value).toBe(1500); // 1000 + 500
    expect(s1_2026.getCell("G").value).toBe(100); // 80 + 20

    const anual = wb.getWorksheet("Anual")!;
    expect(anual.rowCount).toBe(1 + 2 + 1); // encabezado + (2025, 2026) + TOTAL
    expect(anual.getRow(2).getCell("A").value).toBe("2025");
    expect(anual.getRow(3).getCell("A").value).toBe("2026");
    expect(anual.getRow(3).getCell("D").value).toBe(1500);
  });

  it("builds the Por Producto sheet sorted by net profit, as a real filterable Table", async () => {
    const query = mockQuery({
      products: [
        { productId: "MLA1", title: "El más rentable", orders: 3, units: 5, revenue: 5000, commission: 500, shipping: 100, adSpend: 200, cost: 1500, otherTax: 50, iva: 210, netProfit: 2440 },
        { productId: "MLA2", title: "El menos rentable", orders: 1, units: 1, revenue: 100, commission: 13, shipping: 10, adSpend: 5, cost: 30, otherTax: 1, iva: 4, netProfit: 37 },
      ],
    });
    vi.mocked(withScope).mockImplementation((ctx: any, fn: any) => fn({ query }));

    const wb = await loadWorkbook(await GET());
    const sheet = wb.getWorksheet("Por Producto")!;

    expect(sheet.getRow(1).getCell("A").value).toBe("Producto");
    expect(sheet.getRow(2).getCell("A").value).toBe("El más rentable");
    expect(sheet.getRow(2).getCell("E").value).toBe(5000); // revenue
    expect(sheet.getRow(2).getCell("L").value).toBe(2440); // netProfit
    expect(sheet.getRow(3).getCell("A").value).toBe("El menos rentable");
    const totalsRow = sheet.getRow(4);
    expect(totalsRow.getCell("A").value).toBe("TOTAL");
    expectSubtotalFormula(totalsRow.getCell("E"), "TablaPorProducto", "Facturación bruta");
  });

  it("builds the Movimientos sheet with every order_item, including cancelled orders", async () => {
    const query = mockQuery({
      movements: [
        {
          orderId: "O1", dateCreated: "2026-08-05T00:00:00Z", status: "paid",
          productId: "MLA1", productTitle: "Producto de prueba",
          quantity: 2, unitPrice: 1000, mlCommission: 130, shippingCost: 90,
          adsCostAllocated: 50, costApplied: 300, taxApplied: 10, ivaApplied: 42,
          netProfit: 578,
        },
        {
          orderId: "O2", dateCreated: "2026-08-06T00:00:00Z", status: "cancelled",
          productId: "MLA2", productTitle: "Producto cancelado",
          quantity: 1, unitPrice: 500, mlCommission: 65, shippingCost: 0,
          adsCostAllocated: 0, costApplied: null, taxApplied: null, ivaApplied: null,
          netProfit: null,
        },
      ],
    });
    vi.mocked(withScope).mockImplementation((ctx: any, fn: any) => fn({ query }));

    const wb = await loadWorkbook(await GET());
    const sheet = wb.getWorksheet("Movimientos")!;

    expect(sheet.getRow(1).getCell("A").value).toBe("Orden");
    expect(sheet.getRow(2).getCell("A").value).toBe("O1");
    expect(sheet.getRow(2).getCell("B").value).toBe("2026-08-05");
    expect(sheet.getRow(2).getCell("H").value).toBe(2000); // facturación = precio * cantidad
    // La cancelada también sale, con su estado — no se filtra, igual que el CSV.
    expect(sheet.getRow(3).getCell("A").value).toBe("O2");
    expect(sheet.getRow(3).getCell("C").value).toBe("cancelled");
    expect(sheet.getRow(3).getCell("L").value).toBeNull(); // sin costo cargado
  });

  it("shows the last 12 months trend with data bars on Resumen, without crashing when there is no history", async () => {
    vi.mocked(withScope).mockImplementation((ctx: any, fn: any) => fn({ query: mockQuery({}) }));

    const wb = await loadWorkbook(await GET());
    const resumen = wb.getWorksheet("Resumen")!;

    expect(resumen.getCell("A1").value).toBe("Estado financiero — C");
  });
});
