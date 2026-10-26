import { describe, it, expect, vi, beforeEach } from "vitest";

const query = vi.fn();
vi.mock("@/db/client", () => ({ withScope: vi.fn((ctx: unknown, fn: (client: unknown) => unknown) => fn({ query })) }));
vi.mock("@/db/schema-capabilities", () => ({ hasColumn: vi.fn().mockResolvedValue(true) }));
vi.mock("@/lib/current-account", () => ({ resolveCurrentAccount: vi.fn() }));
vi.mock("@/sync/sync-service", () => ({ recalculateProduct: vi.fn().mockResolvedValue(3) }));

import { POST } from "./route";
import { resolveCurrentAccount } from "@/lib/current-account";
import { recalculateProduct } from "@/sync/sync-service";

const account = { id: "acc1", name: "Cuenta", ownerEmail: "a@example.com", mlSellerId: "S1", otherTaxRate: 0, taxCondition: "responsable_inscripto" as const, taxConditionConfirmed: true, createdAt: "2026-01-01" };
const req = (body: unknown) => new Request("http://x/api/products/keep-latest-cost", { method: "POST", body: JSON.stringify(body) }) as any;

describe("POST /api/products/keep-latest-cost", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveCurrentAccount).mockResolvedValue(account);
  });

  it("requires product ids", async () => {
    expect((await POST(req({}))).status).toBe(400);
  });

  it("drops older costs and recalculates only the products that had them", async () => {
    query.mockImplementation(async (_sql: string, params: unknown[]) => ({ rowCount: params[1] === "MLA1" ? 2 : 0, rows: [] }));
    const body = await (await POST(req({ productIds: ["MLA1", "MLA2"] }))).json();
    expect(body).toEqual({ ok: true, products: 1, itemsUpdated: 3 });
    expect(recalculateProduct).toHaveBeenCalledTimes(1);
    expect(String(query.mock.calls[0][0])).toContain("valid_from < (SELECT max(valid_from)");
  });
});
