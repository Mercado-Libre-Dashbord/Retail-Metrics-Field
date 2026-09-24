import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/db/client", () => ({ withScope: vi.fn() }));
vi.mock("@/lib/current-account", () => ({ resolveCurrentAccount: vi.fn() }));

import { GET } from "./route";
import { withScope } from "@/db/client";
import { resolveCurrentAccount } from "@/lib/current-account";
import { resetColumnCache } from "@/db/schema-capabilities";

const account = { id: "acc1", name: "Cuenta", ownerEmail: "a@example.com", mlSellerId: "S1", otherTaxRate: 0, taxCondition: "monotributo" as const, taxConditionConfirmed: true, createdAt: "2026-01-01" };

function req(params: Record<string, string>) {
  return { nextUrl: { searchParams: new URLSearchParams(params) } } as any;
}

const sale = {
  id: 7, orderid: "O1", datecreated: "2026-08-06T12:00:00Z", quantity: 1, unitprice: 12591,
  mlcommission: 3244.77, shippingcost: 8250, adscostallocated: 453.69, taxapplied: 0, ivaapplied: 0,
};

describe("GET /api/products/breakdown", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetColumnCache();
    vi.mocked(resolveCurrentAccount).mockResolvedValue(account);
  });

  it("returns 401 without an account and 400 without productId", async () => {
    vi.mocked(resolveCurrentAccount).mockResolvedValueOnce(null);
    expect((await GET(req({ productId: "MLA1" }))).status).toBe(401);
    expect((await GET(req({}))).status).toBe(400);
  });

  it("breaks the profit down line by line when the applied cost is up to date", async () => {
    const query = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("information_schema.columns")) return { rows: [{ table_name: "order_items", column_name: "iva_applied" }] };
      if (sql.includes("FROM product_costs")) return { rows: [{ cost: 6975, tax: 0, validfrom: "2026-01-01T00:00:00Z" }] };
      if (sql.includes("FROM order_items oi JOIN orders o")) {
        return { rows: [{ ...sale, costapplied: 6975, netprofit: 12591 - 3244.77 - 8250 - 453.69 - 6975 }] };
      }
      return { rows: [] };
    });
    vi.mocked(withScope).mockImplementation((ctx: any, fn: any) => fn({ query }));

    const body = await (await GET(req({ productId: "MLA1" }))).json();

    expect(body.healed).toBe(0);
    expect(body.unitsSold).toBe(1);
    expect(body.totals).toMatchObject({ revenue: 12591, commission: 3244.77, shipping: 8250, ads: 453.69, cost: 6975 });
    expect(body.totals.netProfit).toBeCloseTo(-6332.46, 2);
    expect(query).not.toHaveBeenCalledWith(expect.stringContaining("UPDATE order_items"), expect.anything());
  });

  it("recalculates on the spot when a sale still has an old cost applied", async () => {
    let updated = false;
    const query = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("information_schema.columns")) return { rows: [{ table_name: "order_items", column_name: "iva_applied" }] };
      if (sql.includes("FROM product_costs")) return { rows: [{ cost: 3000, tax: 0, validfrom: "2026-09-20T00:00:00Z" }] };
      if (sql.includes("UPDATE order_items")) {
        updated = true;
        return { rows: [] };
      }
      if (sql.includes("FROM order_items oi JOIN orders o")) {
        const cost = updated ? 3000 : 9000;
        return { rows: [{ ...sale, productid: "MLA1", costapplied: cost, netprofit: 12591 - 3244.77 - 8250 - 453.69 - cost }] };
      }
      return { rows: [] };
    });
    vi.mocked(withScope).mockImplementation((ctx: any, fn: any) => fn({ query }));

    const body = await (await GET(req({ productId: "MLA1" }))).json();

    expect(body.healed).toBe(1);
    expect(updated).toBe(true);
    expect(body.sales[0].costPerUnit).toBe(3000);
  });
});
