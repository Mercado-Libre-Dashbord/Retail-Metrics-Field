import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/db/client", () => ({ withScope: vi.fn() }));
vi.mock("@/lib/current-account", () => ({ resolveCurrentAccount: vi.fn() }));

import { GET } from "./route";
import { withScope } from "@/db/client";
import { resolveCurrentAccount } from "@/lib/current-account";

const account = {
  id: "acc1", name: "Cuenta", ownerEmail: "a@example.com", mlSellerId: "S1",
  otherTaxRate: 0, taxCondition: "responsable_inscripto" as const, taxConditionConfirmed: true, createdAt: "2026-01-01",
};

const req = (qs = "") => ({ nextUrl: { searchParams: new URLSearchParams(qs) } }) as any;

describe("GET /api/campaigns/products", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveCurrentAccount).mockResolvedValue(account);
  });

  it("returns 401 with no active account", async () => {
    vi.mocked(resolveCurrentAccount).mockResolvedValue(null);
    expect((await GET(req())).status).toBe(401);
  });

  it("recomienda pausar un producto cuya ganancia neta (ya con Ads descontado) es negativa", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ productId: "MLA1", title: "Mochila", revenue: 12591, adSpend: 453.69, netProfit: -6332.46 }],
    });
    vi.mocked(withScope).mockImplementation((ctx: any, fn: any) => fn({ query }));

    const body = await (await GET(req())).json();

    expect(body).toEqual([
      { productId: "MLA1", title: "Mochila", revenue: 12591, adSpend: 453.69, netProfit: -6332.46, roas: 12591 / 453.69, recommendation: "pausar" },
    ]);
  });

  it("recomienda aumentar cuando la publicidad es una porción chica de la ganancia que dejaría el producto sin Ads", async () => {
    // Sin Ads, este producto dejaría 1000 (900 + 100 de Ads) — la publicidad
    // es menos de la mitad de eso: hay margen de sobra para poner más plata.
    const query = vi.fn().mockResolvedValue({
      rows: [{ productId: "MLA2", title: "Rentable", revenue: 5000, adSpend: 100, netProfit: 900 }],
    });
    vi.mocked(withScope).mockImplementation((ctx: any, fn: any) => fn({ query }));

    const body = await (await GET(req())).json();

    expect(body[0].recommendation).toBe("aumentar");
  });

  it("recomienda mantener cuando la ganancia es positiva pero la publicidad ya se lleva la mitad o más del margen sin Ads", async () => {
    // Sin Ads dejaría 200 (100 + 100 de Ads) — la publicidad es la mitad
    // exacta: ni conviene apagarlo (todavía da positivo) ni forzarlo más.
    const query = vi.fn().mockResolvedValue({
      rows: [{ productId: "MLA3", title: "Al límite", revenue: 3000, adSpend: 100, netProfit: 100 }],
    });
    vi.mocked(withScope).mockImplementation((ctx: any, fn: any) => fn({ query }));

    const body = await (await GET(req())).json();

    expect(body[0].recommendation).toBe("mantener");
  });

  it("scopes the query to the requested from/to range", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    vi.mocked(withScope).mockImplementation((ctx: any, fn: any) => fn({ query }));

    await GET(req("from=2026-08-01&to=2026-08-31"));

    expect(query).toHaveBeenCalledWith(expect.any(String), ["acc1", "2026-08-01", "2026-08-31"]);
  });
});
