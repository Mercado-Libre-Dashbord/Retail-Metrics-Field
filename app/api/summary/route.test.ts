import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/db/client", () => ({ withScope: vi.fn() }));
vi.mock("@/lib/current-account", () => ({ resolveCurrentAccount: vi.fn(), getCurrentUser: vi.fn() }));
// Las visitas salen de la API de ML en vivo; acá no interesan salvo en su
// propio test, así que por defecto responden "sin dato".
vi.mock("@/mcp/tools", () => ({ getStoreVisits: vi.fn().mockResolvedValue(null) }));

import { GET } from "./route";
import { withScope } from "@/db/client";
import { resolveCurrentAccount, getCurrentUser } from "@/lib/current-account";
import { resetColumnCache } from "@/db/schema-capabilities";
import { getStoreVisits } from "@/mcp/tools";

const account = { id: "acc1", name: "Cuenta", ownerEmail: "a@example.com", mlSellerId: "S1", otherTaxRate: 0, taxCondition: "responsable_inscripto" as const, taxConditionConfirmed: true, createdAt: "2026-01-01" };

describe("GET /api/summary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetColumnCache();
    vi.mocked(resolveCurrentAccount).mockResolvedValue(account);
    vi.mocked(getCurrentUser).mockResolvedValue({ email: "a@example.com", isAdmin: false });
    vi.mocked(getStoreVisits).mockResolvedValue(null);
  });

  it("returns 401 when there is no active account", async () => {
    vi.mocked(resolveCurrentAccount).mockResolvedValue(null);
    const request = { nextUrl: { searchParams: new URLSearchParams() } } as any;
    const res = await GET(request);
    expect(res.status).toBe(401);
  });

  it("computes derived KPIs from the raw totals and ad spend", async () => {
    // adSpend sale directo de la tabla ads_spend (todo lo cargado, cualquier
    // canal) — no de sumar el gasto ya repartido por venta, que puede quedar
    // corto si hubo gasto en un día sin ninguna venta ese día.
    const query = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("ads_spend")) {
        return { rows: [{ total: 200 }] };
      }
      return {
        rows: [
          {
            orders: 2,
            grossSales: 2000,
            totalCommission: 260,
            totalShipping: 180,
            totalCost: 600,
            netProfit: 860,
            itemsMissingCost: 0,
            ordersWithCost: 2,
          },
        ],
      };
    });
    vi.mocked(withScope).mockImplementation((ctx: any, fn: any) => fn({ query }));

    const request = { nextUrl: { searchParams: new URLSearchParams() } } as any;
    const body = await (await GET(request)).json();

    expect(body.orders).toBe(2);
    expect(body.aov).toBe(1000);
    expect(body.adSpend).toBe(200);
    expect(body.mer).toBeCloseTo(2000 / 200);
    expect(body.cpa).toBe(100);
    expect(body.netAov).toBe(430);
    expect(body.trueCpa).toBe(100);
  });

  it("returns zeroed rates instead of dividing by zero when there is no data", async () => {
    const query = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("ads_spend")) return { rows: [{ total: 0 }] };
      return {
        rows: [
          {
            orders: 0,
            grossSales: 0,
            totalCommission: 0,
            totalShipping: 0,
            totalMercadoAds: 0,
            totalCost: 0,
            netProfit: 0,
            itemsMissingCost: 0,
            ordersWithCost: 0,
          },
        ],
      };
    });
    vi.mocked(withScope).mockImplementation((ctx: any, fn: any) => fn({ query }));

    const request = { nextUrl: { searchParams: new URLSearchParams() } } as any;
    const body = await (await GET(request)).json();

    expect(body.aov).toBe(0);
    expect(body.mer).toBe(0);
    expect(body.cpa).toBe(0);
  });

  it("compares against the equivalent previous period", async () => {
    let totalsCalls = 0;
    const query = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("information_schema.columns")) return { rows: [] };
      if (sql.includes("ads_spend")) return { rows: [{ total: 0 }] };
      if (sql.includes("NOT (o.status NOT IN")) return { rows: [{ orders: 0, amount: 0 }] };
      if (sql.includes("totalCommission")) {
        // Totales del período actual (2026-08-01..2026-08-10, 10 días).
        return {
          rows: [
            {
              orders: 4,
              grossSales: 4000,
              totalCommission: 400,
              totalShipping: 200,
              totalMercadoAds: 0,
              totalCost: 1000,
              netProfit: 2400,
              itemsMissingCost: 0,
              ordersWithCost: 4,
            },
          ],
        };
      }
      // El detalle de qué productos no tienen costo no es un total.
      if (sql.includes("GROUP BY oi.product_id")) return { rows: [] };
      // Totales del período anterior (2026-07-22..2026-07-31, mismos 10 días).
      totalsCalls += 1;
      return { rows: [{ orders: 2, grossSales: 2000, netProfit: 1000 }] };
    });
    vi.mocked(withScope).mockImplementation((ctx: any, fn: any) => fn({ query }));

    const request = { nextUrl: { searchParams: new URLSearchParams("from=2026-08-01&to=2026-08-10") } } as any;
    const body = await (await GET(request)).json();

    expect(totalsCalls).toBe(1);
    expect(body.previous).toMatchObject({ orders: 2, grossSales: 2000, netProfit: 1000, profitPct: 0.5 });
  });

  it("excludes cancelled orders from every financial aggregate", async () => {
    const seen: string[] = [];
    const query = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("information_schema.columns")) return { rows: [] };
      if (sql.includes("ads_spend")) return { rows: [{ total: 0 }] };
      // La query de reembolsos invierte el filtro a propósito; no es un agregado.
      if (sql.includes("NOT (o.status NOT IN")) return { rows: [{ orders: 0, amount: 0 }] };
      seen.push(sql);
      // El detalle de costos faltantes también filtra canceladas, y por eso
      // entra en la lista de arriba — pero devuelve filas de otra forma.
      if (sql.includes("GROUP BY oi.product_id")) return { rows: [] };
      return {
        rows: [
          {
            orders: 0, grossSales: 0, totalCommission: 0, totalShipping: 0, totalMercadoAds: 0,
            totalCost: 0, netProfit: 0, itemsMissingCost: 0, ordersWithCost: 0,
          },
        ],
      };
    });
    vi.mocked(withScope).mockImplementation((ctx: any, fn: any) => fn({ query }));

    const request = { nextUrl: { searchParams: new URLSearchParams("from=2026-08-01&to=2026-08-10") } } as any;
    await GET(request);

    // Totales del período, del período anterior, y el detalle de productos sin
    // costo: los tres tienen que dejar afuera las canceladas.
    expect(seen).toHaveLength(3);
    for (const sql of seen) expect(sql).toContain("o.status NOT IN ('cancelled', 'invalid')");
  });

  it("returns the daily breakdown when groupBy=day", async () => {
    const query = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("information_schema.columns")) {
        return { rows: [{ table_name: "order_items", column_name: "tax_applied" }] };
      }
      return {
        rows: [
          { day: "2026-01-05", revenue: 1000, commission: 130, shipping: 90, cost: 300, tax: 20, netProfit: 460 },
        ],
      };
    });
    vi.mocked(withScope).mockImplementation((ctx: any, fn: any) => fn({ query }));

    const request = { nextUrl: { searchParams: new URLSearchParams("groupBy=day") } } as any;
    const body = await (await GET(request)).json();

    expect(body).toEqual([
      { day: "2026-01-05", revenue: 1000, commission: 130, shipping: 90, cost: 300, tax: 20, netProfit: 460 },
    ]);
  });

  it("still returns the daily breakdown when the tax column has not been migrated yet", async () => {
    const query = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("information_schema.columns")) return { rows: [] };
      // Sin la columna la query pide 0 como impuestos en vez de fallar.
      expect(sql).not.toContain("tax_applied");
      return { rows: [{ day: "2026-01-05", revenue: 1000, commission: 130, shipping: 90, cost: 300, tax: 0, netProfit: 480 }] };
    });
    vi.mocked(withScope).mockImplementation((ctx: any, fn: any) => fn({ query }));

    const request = { nextUrl: { searchParams: new URLSearchParams("groupBy=day") } } as any;
    const body = await (await GET(request)).json();

    expect(body[0].tax).toBe(0);
  });

  it("reports pending migrations to admins only", async () => {
    const query = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("information_schema.columns")) return { rows: [] };
      if (sql.includes("ads_spend")) return { rows: [{ total: 0 }] };
      return {
        rows: [
          {
            orders: 0, grossSales: 0, totalCommission: 0, totalShipping: 0, totalMercadoAds: 0,
            totalCost: 0, netProfit: 0, itemsMissingCost: 0, ordersWithCost: 0,
          },
        ],
      };
    });
    vi.mocked(withScope).mockImplementation((ctx: any, fn: any) => fn({ query }));
    const request = { nextUrl: { searchParams: new URLSearchParams() } } as any;

    vi.mocked(getCurrentUser).mockResolvedValue({ email: "a@example.com", isAdmin: false });
    expect((await (await GET(request)).json()).pendingMigrations).toEqual([]);

    resetColumnCache();
    vi.mocked(getCurrentUser).mockResolvedValue({ email: "admin@example.com", isAdmin: true });
    const adminBody = await (await GET(request)).json();
    expect(adminBody.pendingMigrations).toHaveLength(23);
    const sql = adminBody.pendingMigrations.join(" ");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS tax");
    expect(sql).toContain("iva_applied");
    expect(sql).toContain("billing_charges");
    expect(sql).toContain("category_id");
    expect(sql).toContain("thumbnail");
    expect(sql).toContain("other_tax_rate");
    expect(sql).toContain("sync_version");
  });

  it("counts cancelled orders as refunds, separately from revenue", async () => {
    const query = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("information_schema.columns")) return { rows: [] };
      if (sql.includes("ads_spend")) return { rows: [{ total: 0 }] };
      // La query de reembolsos es la que invierte el filtro de estados.
      if (sql.includes("NOT (o.status NOT IN")) return { rows: [{ orders: 3, amount: 62700 }] };
      return {
        rows: [
          {
            orders: 12, grossSales: 240000, totalCommission: 0, totalShipping: 0, totalMercadoAds: 0,
            totalCost: 0, netProfit: 0, itemsMissingCost: 0, ordersWithCost: 0,
          },
        ],
      };
    });
    vi.mocked(withScope).mockImplementation((ctx: any, fn: any) => fn({ query }));

    const request = { nextUrl: { searchParams: new URLSearchParams() } } as any;
    const body = await (await GET(request)).json();

    expect(body.refundOrders).toBe(3);
    expect(body.refundAmount).toBe(62700);
    expect(body.refundRate).toBeCloseTo(3 / 15);
    // Y no contaminan la facturación.
    expect(body.grossSales).toBe(240000);
  });

  it("reports store visits and the conversion rate they imply", async () => {
    vi.mocked(getStoreVisits).mockResolvedValue(2000);
    const query = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("information_schema.columns")) return { rows: [] };
      if (sql.includes("ads_spend")) return { rows: [{ total: 0 }] };
      if (sql.includes("NOT (o.status NOT IN")) return { rows: [{ orders: 0, amount: 0 }] };
      return {
        rows: [
          {
            orders: 40, grossSales: 100000, totalCommission: 0, totalShipping: 0, totalMercadoAds: 0,
            totalCost: 0, netProfit: 0, itemsMissingCost: 0, ordersWithCost: 0,
          },
        ],
      };
    });
    vi.mocked(withScope).mockImplementation((ctx: any, fn: any) => fn({ query }));

    const request = { nextUrl: { searchParams: new URLSearchParams("from=2026-08-01&to=2026-08-10") } } as any;
    const body = await (await GET(request)).json();

    expect(body.visits).toBe(2000);
    expect(body.conversionRate).toBeCloseTo(40 / 2000);
  });

  it("keeps visits null — not zero — when Mercado Libre gives no data", async () => {
    vi.mocked(getStoreVisits).mockResolvedValue(null);
    const query = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("information_schema.columns")) return { rows: [] };
      if (sql.includes("ads_spend")) return { rows: [{ total: 0 }] };
      if (sql.includes("NOT (o.status NOT IN")) return { rows: [{ orders: 0, amount: 0 }] };
      return {
        rows: [
          {
            orders: 5, grossSales: 1000, totalCommission: 0, totalShipping: 0, totalMercadoAds: 0,
            totalCost: 0, netProfit: 0, itemsMissingCost: 0, ordersWithCost: 0,
          },
        ],
      };
    });
    vi.mocked(withScope).mockImplementation((ctx: any, fn: any) => fn({ query }));

    const request = { nextUrl: { searchParams: new URLSearchParams("from=2026-08-01&to=2026-08-10") } } as any;
    const body = await (await GET(request)).json();

    // 0 visitas y "no sabemos" son distintos: con null no se muestra conversión.
    expect(body.visits).toBeNull();
    expect(body.conversionRate).toBeNull();
  });
});
