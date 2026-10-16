import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/db/client", () => ({ withScope: vi.fn() }));
vi.mock("@/lib/current-account", () => ({ resolveCurrentAccount: vi.fn() }));
vi.mock("@/sync/sync-service", () => ({ recalculateProduct: vi.fn().mockResolvedValue(3) }));

import { POST } from "./route";
import { withScope } from "@/db/client";
import { resolveCurrentAccount } from "@/lib/current-account";
import { resetColumnCache } from "@/db/schema-capabilities";

const account = { id: "acc1", name: "C", ownerEmail: "a@e.com", mlSellerId: "S1", otherTaxRate: 0, taxCondition: "responsable_inscripto" as const, taxConditionConfirmed: true, createdAt: "2026-01-01" };
const req = (body: unknown) => ({ json: async () => body }) as any;

function db(costs: Record<string, number | null | "missing">) {
  const query = vi.fn().mockImplementation(async (sql: string, params: unknown[]) => {
    if (sql.includes("information_schema.columns")) {
      return { rows: [{ table_name: "product_costs", column_name: "exchange_rate" }, { table_name: "order_items", column_name: "iva_applied" }] };
    }
    if (sql.includes("FROM products p")) {
      const v = costs[params[1] as string];
      return v === "missing" || v === undefined ? { rows: [] } : { rows: [{ cost: v }] };
    }
    return { rows: [] };
  });
  vi.mocked(withScope).mockImplementation((_c: any, fn: any) => fn({ query }));
  return query;
}

describe("POST /api/products/import-costs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetColumnCache();
    vi.mocked(resolveCurrentAccount).mockResolvedValue(account);
  });

  it("401 sin cuenta", async () => {
    vi.mocked(resolveCurrentAccount).mockResolvedValue(null);
    expect((await POST(req({ items: [{ productId: "A", cost: 1 }] }))).status).toBe(401);
  });

  it("400 con ítems inválidos o demasiados", async () => {
    expect((await POST(req({ items: [] }))).status).toBe(400);
    expect((await POST(req({ items: [{ productId: "A", cost: -1 }] }))).status).toBe(400);
    expect((await POST(req({ items: Array.from({ length: 41 }, (_, i) => ({ productId: `P${i}`, cost: 1 })) }))).status).toBe(400);
  });

  it("inserta los costos que cambian, salta los iguales y cuenta los productos inexistentes", async () => {
    const query = db({ A: null, B: 500, C: 100, D: "missing" });
    const res = await POST(req({ items: [{ productId: "A", cost: 737.29 }, { productId: "B", cost: 500 }, { productId: "C", cost: 120 }, { productId: "D", cost: 9 }] }));
    expect(await res.json()).toEqual({ ok: true, updated: 2, unchanged: 1, missing: 1, itemsUpdated: 6 });
    const inserts = query.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO product_costs"));
    expect(inserts.map(([, p]) => (p as unknown[])[1])).toEqual(["A", "C"]);
    expect(inserts.every(([, p]) => (p as unknown[])[0] === "acc1")).toBe(true);
  });
});
