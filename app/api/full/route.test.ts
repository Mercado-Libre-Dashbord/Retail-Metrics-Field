import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/db/client", () => ({ withScope: vi.fn((ctx: unknown, fn: (client: unknown) => unknown) => fn({ query: vi.fn() })) }));
vi.mock("@/lib/current-account", () => ({ resolveCurrentAccount: vi.fn() }));

import { GET } from "./route";
import { withScope } from "@/db/client";
import { resolveCurrentAccount } from "@/lib/current-account";
import { resetColumnCache } from "@/db/schema-capabilities";

const account = {
  id: "acc1", name: "Cuenta", ownerEmail: "a@example.com", mlSellerId: "S1", otherTaxRate: 0,
  taxCondition: "responsable_inscripto" as const, taxConditionConfirmed: true, createdAt: "2026-01-01",
};

function req(url = "http://x/api/full") {
  return { nextUrl: new URL(url) } as any;
}

/** Todas las columnas opcionales presentes: el caso "todo migrado". */
const ALL_COLUMNS = [
  { table_name: "products", column_name: "full_stock_qty" },
  { table_name: "products", column_name: "full_since" },
  { table_name: "products", column_name: "low_stock_threshold" },
  { table_name: "products", column_name: "thumbnail" },
  { table_name: "billing_charges", column_name: "detail_id" },
];

describe("GET /api/full", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetColumnCache();
    vi.mocked(resolveCurrentAccount).mockResolvedValue(account);
  });

  it("returns 401 when there is no active account", async () => {
    vi.mocked(resolveCurrentAccount).mockResolvedValue(null);
    expect((await GET(req())).status).toBe(401);
  });

  it("degrades to available:false without breaking when migration 013 hasn't run", async () => {
    const query = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("information_schema.columns")) return { rows: [] };
      return { rows: [] };
    });
    vi.mocked(withScope).mockImplementation((ctx: any, fn: any) => fn({ query }));

    const body = await (await GET(req())).json();

    expect(body).toEqual({ available: false });
  });

  it("valoriza el stock con disponible + no disponible, y calcula rotación y previsión de agotamiento", async () => {
    const query = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("information_schema.columns")) return { rows: ALL_COLUMNS };
      if (sql.includes("FROM products p")) {
        return {
          rows: [
            {
              id: "MLA1", title: "Producto Full", thumbnail: null,
              fullStockQty: 10, fullStockUnavailableQty: 5,
              fullSince: new Date(Date.now() - 150 * 86400000).toISOString(),
              lowStockThreshold: 20, currentCost: 100,
            },
          ],
        };
      }
      if (sql.includes("FROM order_items oi JOIN orders o")) {
        // 30 unidades vendidas en los últimos 30 días => 1/día.
        return { rows: [{ product_id: "MLA1", units: "30" }] };
      }
      return { rows: [] };
    });
    vi.mocked(withScope).mockImplementation((ctx: any, fn: any) => fn({ query }));

    const body = await (await GET(req())).json();

    expect(body.available).toBe(true);
    expect(body.products).toHaveLength(1);
    const p = body.products[0];
    // Valorización: (10 disponible + 5 no disponible) * 100 = 1500.
    expect(p.fullStockValue).toBe(1500);
    // Antigüedad ~150 días >= umbral de 120 => en riesgo.
    expect(p.daysInFull).toBeGreaterThanOrEqual(149);
    expect(p.oldStockRisk).toBe(true);
    // Stock bajo: 10 disponibles <= umbral de 20.
    expect(p.lowStock).toBe(true);
    // 1 unidad/día => rotación de 1 día, y con 10 disponibles, 10 días de stock.
    expect(p.rotationDays).toBe(1);
    expect(p.daysUntilStockout).toBe(10);
    // Unidades en Full: 10 disponibles + 5 no disponibles.
    expect(body.totals).toMatchObject({ capital: 1500, productos: 1, unidades: 15, conStockBajo: 1 });
  });

  it("dos publicaciones que comparten depósito cuentan sus unidades una sola vez en los totales", async () => {
    const row = { thumbnail: null, fullStockQty: 10, fullStockUnavailableQty: 0, fullSince: null, lowStockThreshold: null };
    const query = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("information_schema.columns")) return { rows: ALL_COLUMNS };
      if (sql.includes("FROM products p")) {
        return {
          rows: [
            // Clásica y premium del mismo producto: mismo stock físico. Una sin costo cargado.
            { ...row, id: "MLA1", title: "Clásica", currentCost: null, inventoryKey: "INV1" },
            { ...row, id: "MLA2", title: "Premium", currentCost: 100, inventoryKey: "INV1" },
            { ...row, id: "MLA3", title: "Otro", currentCost: 50, inventoryKey: "INV2" },
          ],
        };
      }
      return { rows: [] };
    });
    vi.mocked(withScope).mockImplementation((ctx: any, fn: any) => fn({ query }));

    const body = await (await GET(req())).json();

    // En la tabla siguen las tres publicaciones, cada una con su stock.
    expect(body.products).toHaveLength(3);
    expect(body.products[0]).not.toHaveProperty("inventoryKey");
    // Totales: 10 (INV1, una sola vez) + 10 (INV2) = 20, no 30.
    expect(body.totals).toMatchObject({ productos: 3, unidades: 20, capital: 10 * 100 + 10 * 50 });
  });

  it("los costos de Full usan la misma fecha contable que el Resumen", async () => {
    const query = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("information_schema.columns")) return { rows: ALL_COLUMNS };
      return { rows: [] };
    });
    vi.mocked(withScope).mockImplementation((ctx: any, fn: any) => fn({ query }));

    await GET(req("http://x/api/full?from=2026-08-01&to=2026-08-31"));

    const sql = query.mock.calls.map((c) => String(c[0])).find((s) => s.includes("FROM billing_charges"))!;
    // Un cargo sin fecha cae en el mes de su factura; antes entraba en CUALQUIER período.
    expect(sql).toContain("COALESCE(charged_at::date, to_date(period_key, 'YYYY-MM-DD'))");
    expect(sql).not.toContain("charged_at IS NULL OR");
  });

  it("no calcula rotación ni previsión si no hubo ventas recientes", async () => {
    const query = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("information_schema.columns")) return { rows: ALL_COLUMNS };
      if (sql.includes("FROM products p")) {
        return {
          rows: [
            { id: "MLA2", title: "Sin ventas", thumbnail: null, fullStockQty: 5, fullStockUnavailableQty: 0, fullSince: null, lowStockThreshold: null, currentCost: 50 },
          ],
        };
      }
      return { rows: [] };
    });
    vi.mocked(withScope).mockImplementation((ctx: any, fn: any) => fn({ query }));

    const body = await (await GET(req())).json();

    const p = body.products[0];
    expect(p.rotationDays).toBeNull();
    expect(p.daysUntilStockout).toBeNull();
    expect(p.daysInFull).toBeNull();
  });

  it("suma los costos de Full por sub-categoría, sin mezclar comisión ni envío de venta", async () => {
    const query = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("information_schema.columns")) return { rows: ALL_COLUMNS };
      if (sql.includes("FROM products p")) return { rows: [] };
      if (sql.includes("FROM order_items oi JOIN orders o")) return { rows: [] };
      if (sql.includes("FROM billing_charges")) {
        return {
          rows: [
            { concept: "Almacenamiento Full", detailType: "CHARGE", detailSubType: null, amount: 100 },
            { concept: "Cargo por stock antiguo", detailType: "CHARGE", detailSubType: null, amount: 200 },
            { concept: "Comisión por venta", detailType: "CHARGE", detailSubType: null, amount: 999 },
          ],
        };
      }
      return { rows: [] };
    });
    vi.mocked(withScope).mockImplementation((ctx: any, fn: any) => fn({ query }));

    const body = await (await GET(req())).json();

    expect(body.costsAvailable).toBe(true);
    expect(body.costs).toEqual(
      expect.arrayContaining([
        { detail: "almacenamiento", label: "Almacenamiento", amount: 100 },
        { detail: "stock_antiguo", label: "Stock antiguo (permanencia prolongada)", amount: 200 },
      ])
    );
    // La comisión de venta no es un costo de Full: no debe aparecer acá.
    expect(body.costs.find((c: any) => c.amount === 999)).toBeUndefined();
  });

  it("costsAvailable es false sin la migración de facturación", async () => {
    const query = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("information_schema.columns")) {
        return { rows: ALL_COLUMNS.filter((c) => c.table_name !== "billing_charges") };
      }
      return { rows: [] };
    });
    vi.mocked(withScope).mockImplementation((ctx: any, fn: any) => fn({ query }));

    const body = await (await GET(req())).json();

    expect(body.costsAvailable).toBe(false);
    expect(body.costs).toEqual([]);
  });
});
