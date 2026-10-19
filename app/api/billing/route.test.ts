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
      { month: "2026-09", concept: "Sales charge", detailType: null, detailSubType: null, linked: true, count: 3, amount: 1000 },
      { month: "2026-09", concept: "Comisión por venta", detailType: null, detailSubType: null, linked: true, count: 1, amount: 500 },
      { month: "2026-09", concept: "Percepción IVA RG 4310", detailType: null, detailSubType: null, linked: false, count: 1, amount: 300 },
      { month: "2026-09", concept: "Mercado Envios charge", detailType: null, detailSubType: null, linked: true, count: 2, amount: 200 },
    ]);

    const body = await (await GET(request)).json();

    expect(body.available).toBe(true);
    expect(body.buckets[0]).toMatchObject({ bucket: "comision", label: "Comisiones de venta", amount: 1500, subtracted: 0 });
    expect(body.buckets[0].treatments).toEqual([{ treatment: "per_sale", label: "Ya restado venta por venta", amount: 1500 }]);
    expect(body.buckets.map((b: any) => b.bucket)).toEqual(["comision", "impuesto", "envio"]);
    expect(body.total).toBe(2000);
    expect(body.subtracted).toBe(0);
  });

  it("marca qué se resta de la ganancia: Full y otros sin venta, y lo cargado a mano", async () => {
    client([
      { month: "2026-09", concept: null, detailType: "MANUAL", detailSubType: "manual:otro", linked: false, count: 1, amount: 6094850 },
      { month: "2026-09", concept: "Cargo por almacenamiento Full", detailType: "CHARGE", detailSubType: null, linked: false, count: 1, amount: 42710 },
      { month: "2026-09", concept: "Cargo varios", detailType: "CHARGE", detailSubType: null, linked: true, count: 4, amount: 900 },
      { month: "2026-09", concept: "Product Ads", detailType: "CHARGE", detailSubType: "PADS", linked: false, count: 1, amount: 1000 },
    ]);
    const body = await (await GET(request)).json();
    const otro = body.buckets.find((b: any) => b.bucket === "otro");
    expect(otro.subtracted).toBe(6094850);
    expect(otro.details.map((d: any) => [d.concept, d.treatment])).toEqual([
      ["Cargado a mano", "subtracted"],
      ["Cargo varios", "per_sale"],
    ]);
    expect(body.buckets.find((b: any) => b.bucket === "full").subtracted).toBe(42710);
    expect(body.buckets.find((b: any) => b.bucket === "publicidad").subtracted).toBe(0);
    expect(body.subtracted).toBe(6094850 + 42710);
  });

  it("reports unavailable instead of failing when the billing table is not migrated yet", async () => {
    client([], { hasTable: false });
    const body = await (await GET(request)).json();
    expect(body).toEqual({ available: false, buckets: [], total: 0, subtracted: 0 });
  });
});
