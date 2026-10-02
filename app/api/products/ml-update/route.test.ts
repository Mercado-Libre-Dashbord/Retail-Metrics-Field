import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/db/client", () => ({ withScope: vi.fn((ctx: unknown, fn: (client: unknown) => unknown) => fn({ query: vi.fn() })) }));
vi.mock("@/lib/current-account", () => ({ resolveCurrentAccount: vi.fn() }));
vi.mock("@/mcp/tools", () => ({ updateProductPriceStock: vi.fn() }));

import { POST } from "./route";
import { withScope } from "@/db/client";
import { resolveCurrentAccount } from "@/lib/current-account";
import { updateProductPriceStock } from "@/mcp/tools";
import { MlApiError } from "@/mcp/ml-client";

const account = { id: "acc1", name: "Cuenta", ownerEmail: "a@example.com", mlSellerId: "S1", otherTaxRate: 0, taxCondition: "responsable_inscripto" as const, taxConditionConfirmed: true, createdAt: "2026-01-01" };

describe("POST /api/products/ml-update", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveCurrentAccount).mockResolvedValue(account);
  });

  it("returns 401 when there is no active account", async () => {
    vi.mocked(resolveCurrentAccount).mockResolvedValue(null);
    const request = { json: async () => ({ productId: "MLA1", price: 100 }) } as any;
    expect((await POST(request)).status).toBe(401);
  });

  it("returns 400 when neither price nor stock is given", async () => {
    const request = { json: async () => ({ productId: "MLA1" }) } as any;
    expect((await POST(request)).status).toBe(400);
  });

  it("returns 400 for a productId that is not a listing id (it goes into the Mercado Libre URL)", async () => {
    const request = { json: async () => ({ productId: "MLA1/../../users/me", price: 100 }) } as any;
    expect((await POST(request)).status).toBe(400);
  });

  it("returns 400 for a non-positive price", async () => {
    const request = { json: async () => ({ productId: "MLA1", price: 0 }) } as any;
    expect((await POST(request)).status).toBe(400);
  });

  it("returns 400 for a negative stock", async () => {
    const request = { json: async () => ({ productId: "MLA1", stock: -1 }) } as any;
    expect((await POST(request)).status).toBe(400);
  });

  it("writes to Mercado Libre then updates the local row", async () => {
    vi.mocked(updateProductPriceStock).mockResolvedValue(undefined);
    const query = vi.fn().mockResolvedValue({ rows: [{ currentPrice: 21500, stock: 10 }] });
    vi.mocked(withScope).mockImplementation((ctx: any, fn: any) => fn({ query }));
    const request = { json: async () => ({ productId: "MLA1", price: 21500, stock: 10 }) } as any;

    const res = await POST(request);

    expect(await res.json()).toEqual({ ok: true, product: { currentPrice: 21500, stock: 10 } });
    expect(updateProductPriceStock).toHaveBeenCalledWith("acc1", "MLA1", { price: 21500, stock: 10 });
  });

  it("returns 502 without touching the local row when Mercado Libre rejects the write", async () => {
    vi.mocked(updateProductPriceStock).mockRejectedValue(new MlApiError(403, "write scope missing"));
    const query = vi.fn();
    vi.mocked(withScope).mockImplementation((ctx: any, fn: any) => fn({ query }));
    const request = { json: async () => ({ productId: "MLA1", price: 21500 }) } as any;

    const res = await POST(request);

    expect(res.status).toBe(502);
    expect(query).not.toHaveBeenCalled();
  });
});
