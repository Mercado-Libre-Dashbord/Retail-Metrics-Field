import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/current-account", () => ({ resolveCurrentAccount: vi.fn() }));
vi.mock("@/mcp/tools", () => ({ listCampaigns: vi.fn(), setCampaignStatus: vi.fn() }));

import { GET, PATCH } from "./route";
import { resolveCurrentAccount } from "@/lib/current-account";
import { listCampaigns, setCampaignStatus } from "@/mcp/tools";
import { MlApiError } from "@/mcp/ml-client";

const account = { id: "acc1", name: "Cuenta", ownerEmail: "a@example.com", mlSellerId: "S1", otherTaxRate: 0, taxCondition: "responsable_inscripto" as const, taxConditionConfirmed: true, createdAt: "2026-01-01" };

describe("GET /api/campaigns", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveCurrentAccount).mockResolvedValue(account);
  });

  it("returns 401 when there is no active account", async () => {
    vi.mocked(resolveCurrentAccount).mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
  });

  it("returns 400 when the account has no ML seller connected", async () => {
    vi.mocked(resolveCurrentAccount).mockResolvedValue({ ...account, mlSellerId: null });
    expect((await GET()).status).toBe(400);
  });

  it("returns the campaign list", async () => {
    vi.mocked(listCampaigns).mockResolvedValue([{ id: "1", name: "Campaña 1", status: "active", budget: 5000 }]);
    const res = await GET();
    expect(await res.json()).toEqual([{ id: "1", name: "Campaña 1", status: "active", budget: 5000 }]);
  });

  it("returns 502 when Mercado Libre fails", async () => {
    vi.mocked(listCampaigns).mockRejectedValue(new MlApiError(500, "boom"));
    expect((await GET()).status).toBe(502);
  });
});

describe("PATCH /api/campaigns", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveCurrentAccount).mockResolvedValue(account);
  });

  it("returns 401 when there is no active account", async () => {
    vi.mocked(resolveCurrentAccount).mockResolvedValue(null);
    const request = { json: async () => ({ campaignId: "1", status: "paused" }) } as any;
    expect((await PATCH(request)).status).toBe(401);
  });

  it("returns 400 for an invalid status", async () => {
    const request = { json: async () => ({ campaignId: "1", status: "deleted" }) } as any;
    expect((await PATCH(request)).status).toBe(400);
  });

  it("returns 400 for a campaignId that is not numeric (it goes into the Mercado Ads URL)", async () => {
    const request = { json: async () => ({ campaignId: "1/../../users/me", status: "paused" }) } as any;
    expect((await PATCH(request)).status).toBe(400);
  });

  it("returns 400 for a malformed JSON body", async () => {
    const request = { json: async () => { throw new SyntaxError("Unexpected token"); } } as any;
    expect((await PATCH(request)).status).toBe(400);
  });

  it("pauses the campaign", async () => {
    vi.mocked(setCampaignStatus).mockResolvedValue(undefined);
    const request = { json: async () => ({ campaignId: "1", status: "paused" }) } as any;

    const res = await PATCH(request);

    expect(await res.json()).toEqual({ ok: true });
    expect(setCampaignStatus).toHaveBeenCalledWith("acc1", "1", "paused");
  });

  it("returns 502 when Mercado Libre rejects the status change", async () => {
    vi.mocked(setCampaignStatus).mockRejectedValue(new MlApiError(403, "write scope missing"));
    const request = { json: async () => ({ campaignId: "1", status: "paused" }) } as any;
    expect((await PATCH(request)).status).toBe(502);
  });
});
