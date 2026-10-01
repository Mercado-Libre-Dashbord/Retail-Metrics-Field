import { describe, it, expect, vi } from "vitest";

vi.mock("@/db/client", () => ({ withScope: vi.fn() }));
vi.mock("@/db/tokens", () => ({ saveTokens: vi.fn() }));
vi.mock("@/db/accounts", () => ({ setAccountMlSellerId: vi.fn() }));
vi.mock("@/lib/current-account", () => ({
  getCurrentUser: vi.fn().mockResolvedValue(null),
  resolveCurrentAccount: vi.fn().mockResolvedValue(null),
}));

import { GET } from "./route";

/** Request con el state en la URL y, opcionalmente, en la cookie del navegador. */
function req(params: Record<string, string>, cookieState?: string) {
  return {
    nextUrl: { searchParams: new URLSearchParams(params) },
    cookies: { get: (name: string) => (name === "ml_oauth_state" && cookieState ? { value: cookieState } : undefined) },
    url: "https://retail.metricsfield.com/api/ml/callback",
  } as any;
}
import { resolveCurrentAccount } from "@/lib/current-account";

describe("GET /api/ml/callback", () => {
  it("returns 400 when the authorization code is missing", async () => {
    const res = await GET(req({ state: "acc1.n" }, "acc1.n"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Missing authorization code" });
  });

  it("returns 400 when the state is missing", async () => {
    const res = await GET(req({ code: "abc" }, "acc1.n"));
    expect(res.status).toBe(400);
  });

  it("rechaza un state que este navegador no pidió (CSRF en la vinculación)", async () => {
    // Link armado por un tercero: el state es válido para la cuenta de la
    // víctima, pero el navegador de la víctima no inició esa autorización.
    const res = await GET(req({ code: "codigo-del-atacante", state: "victim-account.nonce-del-atacante" }));
    expect(res.status).toBe(400);
    const otherNonce = await GET(req({ code: "abc", state: "acc1.otro" }, "acc1.propio"));
    expect(otherNonce.status).toBe(400);
  });

  it("rejects an unauthenticated caller instead of trusting state as the account id", async () => {
    vi.mocked(resolveCurrentAccount).mockResolvedValueOnce(null);
    const res = await GET(req({ code: "abc", state: "victim-account.n" }, "victim-account.n"));
    expect(res.status).toBe(401);
  });

  it("rejects when state doesn't match the caller's own resolved account (anti-IDOR)", async () => {
    vi.mocked(resolveCurrentAccount).mockResolvedValueOnce({
      id: "attacker-own-account",
      name: "Attacker",
      ownerEmail: "attacker@example.com",
      mlSellerId: null,
      otherTaxRate: 0, taxCondition: "responsable_inscripto" as const, taxConditionConfirmed: true,
      createdAt: "2026-01-01T00:00:00Z",
    });
    const res = await GET(req({ code: "abc", state: "victim-account.n" }, "victim-account.n"));
    expect(res.status).toBe(401);
  });
});
