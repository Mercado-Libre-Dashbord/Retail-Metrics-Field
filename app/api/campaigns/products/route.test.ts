import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/db/client", () => ({ withScope: vi.fn() }));
vi.mock("@/lib/current-account", () => ({ resolveCurrentAccount: vi.fn() }));
vi.mock("@/mcp/tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/mcp/tools")>();
  return { ...actual, getProductAdsReport: vi.fn() };
});

import { GET } from "./route";
import { withScope } from "@/db/client";
import { resolveCurrentAccount } from "@/lib/current-account";
import { getProductAdsReport } from "@/mcp/tools";

const account = {
  id: "acc1", name: "Cuenta", ownerEmail: "a@example.com", mlSellerId: "S1",
  otherTaxRate: 0, taxCondition: "responsable_inscripto" as const, taxConditionConfirmed: true, createdAt: "2026-01-01",
};
const req = (qs = "from=2026-09-01&to=2026-09-28") => ({ nextUrl: { searchParams: new URLSearchParams(qs) } }) as any;

const item = (over: Record<string, unknown>) => ({
  itemId: "MLA1", campaignId: "C1", clicks: 0, prints: 0, cost: 0, directAmount: 0, indirectAmount: 0,
  totalAmount: 0, units: 0, organicUnits: 0, organicAmount: 0, ...over,
});

function dbReturning(perProduct: any[], accountRevenue: number) {
  const query = vi.fn().mockImplementation(async (sql: string) =>
    sql.includes("unnest") ? { rows: perProduct } : { rows: [{ revenue: accountRevenue }] }
  );
  vi.mocked(withScope).mockImplementation((ctx: any, fn: any) => fn({ query }));
}

describe("GET /api/campaigns/products (reporte real de Mercado Ads)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveCurrentAccount).mockResolvedValue(account);
  });

  it("returns 401 with no active account", async () => {
    vi.mocked(resolveCurrentAccount).mockResolvedValue(null);
    expect((await GET(req())).status).toBe(401);
  });

  it("calcula ROAS y ACOS con las ventas atribuidas al anuncio, no con toda la facturación del producto", async () => {
    vi.mocked(getProductAdsReport).mockResolvedValue({
      available: true, from: "2026-09-01", to: "2026-09-28", clamped: false,
      campaigns: [{ id: "C1", name: "Hogar", status: "active", budget: 5000 }],
      items: [item({ itemId: "MLA1", cost: 1000, totalAmount: 8000, units: 4, organicUnits: 12, clicks: 200, prints: 10000 })],
    });
    // El producto facturó 64.000 en total (orgánico + Ads) con 40% de margen antes de Ads.
    dbReturning([{ productId: "MLA1", title: "Sartén", revenue: 64000, netBeforeAds: 25600, missingCost: 0 }], 200000);

    const body = await (await GET(req())).json();
    const p = body.products[0];

    expect(p.roas).toBe(8); // 8000 / 1000, no 64000 / 1000
    expect(p.acos).toBeCloseTo(0.125);
    expect(p.breakevenAcos).toBeCloseTo(0.4);
    expect(p.adsProfit).toBeCloseTo(8000 * 0.4 - 1000);
    expect(p.recommendation).toBe("aumentar");
    expect(p.adShare).toBeCloseTo(4 / 16);
    expect(p.ctr).toBeCloseTo(0.02);
    expect(p.cpc).toBe(5);
    expect(p.cvr).toBeCloseTo(0.02);
    expect(body.totals).toMatchObject({ spend: 1000, adRevenue: 8000, roas: 8 });
    expect(body.totals.tacos).toBeCloseTo(1000 / 200000);
    expect(body.campaigns[0]).toMatchObject({ id: "C1", name: "Hogar", spend: 1000, adRevenue: 8000, roas: 8, products: 1 });
  });

  it("recomienda pausar cuando el ACOS supera el margen, y cuando gasta sin vender por publicidad", async () => {
    vi.mocked(getProductAdsReport).mockResolvedValue({
      available: true, from: "2026-09-01", to: "2026-09-28", clamped: false, campaigns: [],
      items: [
        item({ itemId: "CARO", cost: 3000, totalAmount: 10000 }),
        item({ itemId: "NADA", cost: 500, totalAmount: 0 }),
      ],
    });
    dbReturning(
      [
        { productId: "CARO", title: "Caro", revenue: 10000, netBeforeAds: 2000, missingCost: 0 },
        { productId: "NADA", title: "Nada", revenue: 0, netBeforeAds: null, missingCost: 0 },
      ],
      10000
    );
    const body = await (await GET(req())).json();
    const byId = Object.fromEntries(body.products.map((p: any) => [p.productId, p]));
    expect(byId.CARO.recommendation).toBe("pausar"); // ACOS 30% > margen 20%
    expect(byId.NADA.recommendation).toBe("pausar"); // gasta y no vendió nada por publicidad
  });

  it("sin costo cargado no recomienda nada", async () => {
    vi.mocked(getProductAdsReport).mockResolvedValue({
      available: true, from: "2026-09-01", to: "2026-09-28", clamped: false, campaigns: [],
      items: [item({ itemId: "MLA1", cost: 100, totalAmount: 1000 })],
    });
    dbReturning([{ productId: "MLA1", title: "X", revenue: 1000, netBeforeAds: null, missingCost: 2 }], 1000);
    const body = await (await GET(req())).json();
    expect(body.products[0].recommendation).toBe("sin_costo");
  });

  it("avisa si la cuenta no tiene Product Ads", async () => {
    vi.mocked(getProductAdsReport).mockResolvedValue({ available: false, from: null, to: null, clamped: false, items: [], campaigns: [] });
    const body = await (await GET(req())).json();
    expect(body).toMatchObject({ available: false, products: [] });
  });

  it("devuelve un error entendible si Mercado Ads falla", async () => {
    vi.mocked(getProductAdsReport).mockRejectedValue(new Error("boom"));
    const res = await GET(req());
    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain("Mercado Ads");
  });
});
