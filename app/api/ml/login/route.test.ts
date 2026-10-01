import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/current-account", () => ({ resolveCurrentAccount: vi.fn() }));

import { GET } from "./route";
import { resolveCurrentAccount } from "@/lib/current-account";

describe("GET /api/ml/login", () => {
  it("manda a Mercado Libre con un state aleatorio y lo guarda en una cookie httpOnly", async () => {
    vi.mocked(resolveCurrentAccount).mockResolvedValue({ id: "acc1" } as any);
    const first = await GET();
    const second = await GET();

    const state = new URL(first.headers.get("location")!).searchParams.get("state")!;
    const otherState = new URL(second.headers.get("location")!).searchParams.get("state")!;
    expect(state.startsWith("acc1.")).toBe(true);
    expect(state).not.toBe(otherState); // no predecible
    const cookie = first.cookies.get("ml_oauth_state");
    expect(cookie?.value).toBe(state);
    expect(cookie?.httpOnly).toBe(true);
  });

  it("sin cuenta activa no inicia la autorización", async () => {
    vi.mocked(resolveCurrentAccount).mockResolvedValue(null);
    expect((await GET()).status).toBe(400);
  });
});
