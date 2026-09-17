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
}) {
  return vi.fn().mockImplementation(async (sql: string) => {
    if (sql.includes("information_schema.columns")) {
      return { rows: [{ table_name: "order_items", column_name: "tax_applied" }, { table_name: "order_items", column_name: "iva_applied" }] };
    }
    // Marcadores únicos por consulta: ads es la única que lee de ads_spend;
    // refunds es la única que envuelve revenueStatusFilter() en NOT (...);
    // cualquier otra cosa que toque order_items/orders es la de ventas.
    if (sql.includes("FROM ads_spend")) return { rows: data.ads ?? [] };
    if (sql.includes("NOT (o.status NOT IN")) return { rows: data.refunds ?? [] };
    return { rows: data.sales ?? [] };
  });
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

  it("adds a placeholder sheet when the account has no sales yet", async () => {
    vi.mocked(withScope).mockImplementation((ctx: any, fn: any) => fn({ query: mockQuery({}) }));

    const wb = await loadWorkbook(await GET());

    expect(wb.worksheets.map((s) => s.name)).toEqual(["Mensual"]);
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

    expect(wb.worksheets.map((s) => s.name)).toEqual(["Mensual", "Trimestral", "Semestral", "Anual"]);

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
    expect(total.getCell("D").value).toBe(1700); // 1000 + 500 + 200

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
});
