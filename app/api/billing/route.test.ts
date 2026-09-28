import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/db/client", () => ({ withScope: vi.fn() }));
vi.mock("@/lib/current-account", () => ({ resolveCurrentAccount: vi.fn() }));

import { GET } from "./route";
import { withScope } from "@/db/client";
import { resolveCurrentAccount } from "@/lib/current-account";
import { resetColumnCache } from "@/db/schema-capabilities";

const account = { id: "acc1", name: "Cuenta", ownerEmail: "a@example.com", mlSellerId: "S1", otherTaxRate: 0, taxCondition: "responsable_inscripto" as const, taxConditionConfirmed: true, createdAt: "2026-01-01" };
const request = { nextUrl: { searchParams: new URLSearchParams() } } as any;

function client(rows: any[], { hasTable = true } = {}) {
  const query = vi.fn().mockImplementation(async (sql: string) => {
    if (sql.includes("information_schema.columns")) {
      return { rows: hasTable ? [{ table_name: "billing_charges", column_name: "detail_id" }] : [] };
    }
    return { rows };
  });
  vi.mocked(withScope).mockImplementation((ctx: any, fn: any) => fn({ query }));
  return query;
}

describe("GET /api/billing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetColumnCache();
    vi.mocked(resolveCurrentAccount).mockResolvedValue(account);
  });

  it("returns 401 without an active account", async () => {
    vi.mocked(resolveCurrentAccount).mockResolvedValue(null);
    expect((await GET(request)).status).toBe(401);
  });

  it("groups real ML charges by concept, biggest first", async () => {
    client([
      { concept: "Sales charge", detailType: null, detailSubType: null, amount: 1000 },
      { concept: "Comisión por venta", detailType: null, detailSubType: null, amount: 500 },
      { concept: "Percepción IVA RG 4310", detailType: null, detailSubType: null, amount: 300 },
      { concept: "Mercado Envios charge", detailType: null, detailSubType: null, amount: 200 },
    ]);

    const body = await (await GET(request)).json();

    expect(body.available).toBe(true);
    expect(body.buckets[0]).toEqual({ bucket: "comision", label: "Comisiones de venta", amount: 1500 });
    expect(body.buckets.map((b: any) => b.bucket)).toEqual(["comision", "impuesto", "envio"]);
    expect(body.total).toBe(2000);
  });

  it("reports unavailable instead of failing when the billing table is not migrated yet", async () => {
    client([], { hasTable: false });
    const body = await (await GET(request)).json();
    expect(body).toEqual({ available: false, buckets: [], total: 0 });
  });
});
