import { describe, it, expect } from "vitest";
import { describeCode, priceChanges, readCompetition, type CompetitionSnapshot } from "./competition";
import type { PricingRates } from "./pricing";

const rates: PricingRates = { commission: 0.15, iva: 0.05, tax: 0.03, ads: 0.02, shippingPerUnit: 500, estimated: false };
const snap = (o: Partial<CompetitionSnapshot> = {}): CompetitionSnapshot => ({
  status: "competing", myPrice: 12000, priceToWin: 11000, winnerItemId: "MLA9", winnerPrice: 11050, reasons: [], boosts: [], ...o,
});

describe("readCompetition", () => {
  it("pierde por precio y le conviene igualar si el margen aguanta", () => {
    const r = readCompetition(snap(), 5000, rates, 0.2);
    expect(r.cause).toBe("precio");
    expect(r.overBy).toBe(1000);
    // 11000 × 0,75 − 5000 − 500 = 2750 → 25%
    expect(r.marginAtWin).toBeCloseTo(0.25);
    expect(r.verdict).toBe("igualar_conviene");
  });

  it("avisa cuando igualar deja menos que el objetivo", () => {
    expect(readCompetition(snap(), 6500, rates, 0.2).verdict).toBe("igualar_bajo_objetivo");
  });

  it("avisa cuando igualar hace perder plata", () => {
    expect(readCompetition(snap(), 8000, rates, 0.2).verdict).toBe("igualar_pierde");
  });

  it("si ya es más barato y pierde igual, no es por precio y dice qué le falta", () => {
    const r = readCompetition(
      snap({ myPrice: 10900, priceToWin: 10900, boosts: [{ id: "free_shipping", status: "opportunity" }, { id: "fulfillment", status: "boosted" }], reasons: ["reputation_below_threshold"] }),
      5000, rates, 0.2
    );
    expect(r.cause).toBe("no_precio");
    expect(r.verdict).toBe("no_hace_falta");
    expect(r.missing).toEqual(["envío gratis", "reputación"]);
    expect(r.have).toEqual(["Mercado Envíos Full"]);
  });

  it("cuando gana no propone tocar nada", () => {
    expect(readCompetition(snap({ status: "winning" }), 5000, rates, 0.2)).toMatchObject({ cause: "ganas", verdict: "no_hace_falta" });
  });

  it("sin costo no inventa el margen", () => {
    expect(readCompetition(snap(), null, rates, 0.2)).toMatchObject({ verdict: "sin_costo", marginAtWin: null });
  });
});

describe("describeCode", () => {
  it("traduce los códigos conocidos y deja los desconocidos legibles", () => {
    expect(describeCode("free_installments")).toBe("cuotas sin interés");
    expect(describeCode("same_day_shipping")).toBe("envío en el día");
    expect(describeCode("algo_nuevo")).toBe("algo nuevo");
  });
});

describe("priceChanges", () => {
  it("lista cada cambio de precio de cada competidor, el más reciente primero", () => {
    const changes = priceChanges([
      { itemId: "A", sellerNickname: "TIENDA_A", price: 100, capturedAt: "2026-11-01T10:00:00Z" },
      { itemId: "A", sellerNickname: "TIENDA_A", price: 90, capturedAt: "2026-11-02T10:00:00Z" },
      { itemId: "B", sellerNickname: "TIENDA_B", price: 50, capturedAt: "2026-11-01T10:00:00Z" },
      { itemId: "B", sellerNickname: "TIENDA_B", price: 55, capturedAt: "2026-11-03T10:00:00Z" },
    ]);
    expect(changes.map((c) => [c.itemId, c.from, c.to])).toEqual([["B", 50, 55], ["A", 100, 90]]);
    expect(changes[1].changePct).toBeCloseTo(-0.1);
  });
});
