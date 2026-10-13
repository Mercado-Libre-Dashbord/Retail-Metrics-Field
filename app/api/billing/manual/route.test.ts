import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/db/client", () => ({ withScope: vi.fn() }));
vi.mock("@/lib/current-account", () => ({ resolveCurrentAccount: vi.fn() }));

import { GET, POST, DELETE } from "./route";
import { withScope } from "@/db/client";
import { resolveCurrentAccount } from "@/lib/current-account";
import { resetColumnCache } from "@/db/schema-capabilities";

const account = { id: "acc1", name: "Cuenta", ownerEmail: "a@example.com", mlSellerId: "S1", otherTaxRate: 0, taxCondition: "responsable_inscripto" as const, taxConditionConfirmed: true, createdAt: "2026-01-01" };

function getRequest(params: Record<string, string> = {}) {
  return { nextUrl: { searchParams: new URLSearchParams(params) } } as any;
}
function postRequest(body: unknown) {
  return { json: async () => body } as any;
}

function client({ rows = [] as any[], rowCount = 1, hasTable = true } = {}) {
  const query = vi.fn().mockImplementation(async (sql: string) => {
    if (sql.includes("information_schema.columns")) {
      return { rows: hasTable ? [{ table_name: "billing_charges", column_name: "detail_id" }] : [] };
    }
    return { rows, rowCount };
  });
  vi.mocked(withScope).mockImplementation((ctx: any, fn: any) => fn({ query }));
  return query;
}

const valid = { date: "2026-10-05", bucket: "comision", amount: 12500, description: "Factura A-0001" };

describe("/api/billing/manual", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetColumnCache();
    vi.mocked(resolveCurrentAccount).mockResolvedValue(account);
  });

  it("returns 401 without an active account", async () => {
    vi.mocked(resolveCurrentAccount).mockResolvedValue(null);
    expect((await GET(getRequest())).status).toBe(401);
    expect((await POST(postRequest(valid))).status).toBe(401);
    expect((await DELETE(getRequest({ id: "manual-x" }))).status).toBe(401);
  });

  it("saves a manual charge tagged with the concept the seller picked", async () => {
    const query = client();
    const res = await POST(postRequest(valid));
    expect(res.status).toBe(200);

    const insert = query.mock.calls.find(([sql]) => sql.includes("INSERT INTO billing_charges"))!;
    const [accountId, detailId, periodKey, detailType, subType, concept, amount, date] = insert[1];
    expect(accountId).toBe("acc1");
    expect(detailId).toMatch(/^manual-/);
    expect(periodKey).toBe("2026-10");
    expect(detailType).toBe("MANUAL");
    expect(subType).toBe("manual:comision");
    expect(concept).toBe("Factura A-0001");
    expect(amount).toBe(12500);
    expect(date).toBe("2026-10-05");
  });

  it("accepts a negative amount (credit note)", async () => {
    client();
    expect((await POST(postRequest({ ...valid, amount: -3000 }))).status).toBe(200);
  });

  it("rejects invalid input", async () => {
    client();
    expect((await POST(postRequest({ ...valid, date: "05/10/2026" }))).status).toBe(400);
    expect((await POST(postRequest({ ...valid, bucket: "cualquiera" }))).status).toBe(400);
    expect((await POST(postRequest({ ...valid, amount: 0 }))).status).toBe(400);
    expect((await POST(postRequest({ ...valid, amount: "100" }))).status).toBe(400);
  });

  it("lists manual charges with their concept label", async () => {
    client({
      rows: [{ id: "manual-1", date: "2026-10-05", concept: "Factura A-0001", detailSubType: "manual:envio", amount: "800" }],
    });
    const body = await (await GET(getRequest({ from: "2026-10-01", to: "2026-10-31" }))).json();
    expect(body).toEqual([
      { id: "manual-1", date: "2026-10-05", bucket: "envio", label: "Envíos", description: "Factura A-0001", amount: 800 },
    ]);
  });

  it("only deletes manual charges, never synced ones", async () => {
    const query = client();
    expect((await DELETE(getRequest({ id: "123456789" }))).status).toBe(400);
    expect(query).not.toHaveBeenCalled();

    expect((await DELETE(getRequest({ id: "manual-1" }))).status).toBe(200);
    const [sql, params] = query.mock.calls.at(-1)!;
    expect(sql).toContain("detail_type = $3");
    expect(params).toEqual(["acc1", "manual-1", "MANUAL"]);
  });

  it("returns 404 when the charge does not exist", async () => {
    client({ rowCount: 0 });
    expect((await DELETE(getRequest({ id: "manual-nope" }))).status).toBe(404);
  });
});
