import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/current-account", () => ({ resolveCurrentAccount: vi.fn() }));

import { GET } from "./route";
import { resolveCurrentAccount } from "@/lib/current-account";
import { resetExchangeRateCache } from "@/lib/exchange-rate";

const account = { id: "acc1", name: "Cuenta", ownerEmail: "a@example.com", mlSellerId: "S1", otherTaxRate: 0, taxCondition: "responsable_inscripto" as const, taxConditionConfirmed: true, createdAt: "2026-01-01" };

function mockFetchResponses(map: Record<string, unknown>) {
  return vi.fn().mockImplementation(async (url: string) => {
    const body = map[url];
    if (body === undefined) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => body };
  });
}

describe("GET /api/exchange-rate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetExchangeRateCache();
    vi.mocked(resolveCurrentAccount).mockResolvedValue(account);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns 401 when there is no active account", async () => {
    vi.mocked(resolveCurrentAccount).mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
  });

  it("devuelve la cotización oficial y blue en un solo objeto", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchResponses({
        "https://dolarapi.com/v1/dolares/oficial": { compra: 900, venta: 940, fechaActualizacion: "2026-09-12T13:00:00.000Z" },
        "https://dolarapi.com/v1/dolares/blue": { compra: 1400, venta: 1420, fechaActualizacion: "2026-09-12T13:00:00.000Z" },
      })
    );

    const body = await (await GET()).json();

    expect(body.oficial).toEqual({ compra: 900, venta: 940, fecha: "2026-09-12T13:00:00.000Z" });
    expect(body.blue).toEqual({ compra: 1400, venta: 1420, fecha: "2026-09-12T13:00:00.000Z" });
  });

  it("no rompe la respuesta si una de las dos fuentes falla: la otra igual llega", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchResponses({
        "https://dolarapi.com/v1/dolares/blue": { compra: 1400, venta: 1420, fechaActualizacion: "2026-09-12T13:00:00.000Z" },
      })
    );

    const body = await (await GET()).json();

    expect(body.oficial).toBeNull();
    expect(body.blue).toEqual({ compra: 1400, venta: 1420, fecha: "2026-09-12T13:00:00.000Z" });
  });

  it("no vuelve a pedirle a la API externa si ya hay una cotización reciente en cache", async () => {
    const fetchMock = mockFetchResponses({
      "https://dolarapi.com/v1/dolares/oficial": { compra: 900, venta: 940, fechaActualizacion: "2026-09-12T13:00:00.000Z" },
      "https://dolarapi.com/v1/dolares/blue": { compra: 1400, venta: 1420, fechaActualizacion: "2026-09-12T13:00:00.000Z" },
    });
    vi.stubGlobal("fetch", fetchMock);

    await GET();
    await GET();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
