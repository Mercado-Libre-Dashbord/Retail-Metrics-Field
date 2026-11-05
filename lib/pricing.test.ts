import { describe, it, expect } from "vitest";
import { computePricing, marginAt, ratesFrom, roundUpTo10, type SalesTotals } from "./pricing";

const own = (o: Partial<SalesTotals> = {}): SalesTotals => ({ units: 10, revenue: 100000, commission: 15000, shipping: 5000, iva: 5000, tax: 3000, ads: 2000, ...o });
const account: SalesTotals = { units: 1000, revenue: 10_000_000, commission: 1_200_000, shipping: 300_000, iva: 400_000, tax: 300_000, ads: 100_000 };

describe("ratesFrom", () => {
  it("usa las tasas de la publicación cuando vendió lo suficiente", () => {
    const r = ratesFrom(own(), account);
    expect(r).toMatchObject({ commission: 0.15, iva: 0.05, tax: 0.03, ads: 0.02, shippingPerUnit: 500, estimated: false });
  });

  it("con pocas ventas usa las de la cuenta y lo marca como estimado", () => {
    const r = ratesFrom(own({ units: 1 }), account);
    expect(r.estimated).toBe(true);
    expect(r.commission).toBeCloseTo(0.12);
    expect(r.shippingPerUnit).toBe(300);
  });
});

describe("computePricing", () => {
  const rates = ratesFrom(own(), account); // tasas variables 25%, envío $500

  it("calcula piso, sugerido y margen actual", () => {
    const r = computePricing(10000, 5500, rates, 0.2);
    // ganancia = 10000 × 0,75 − 5500 − 500 = 1500
    expect(r.unitProfit).toBeCloseTo(1500);
    expect(r.margin).toBeCloseTo(0.15);
    // piso = 6000 / 0,75 = 8000
    expect(r.floorPrice).toBeCloseTo(8000);
    // sugerido = 6000 / 0,55 = 10909,09 → 10910
    expect(r.suggestedPrice).toBe(10910);
    expect(r.status).toBe("bajo_objetivo");
  });

  it("marca bajo el piso cuando el precio actual pierde plata", () => {
    expect(computePricing(7000, 5500, rates, 0.2).status).toBe("bajo_piso");
  });

  it("está ok cuando ya deja el margen objetivo", () => {
    expect(computePricing(12000, 5500, rates, 0.2).status).toBe("ok");
  });

  it("sin costo cargado no inventa nada", () => {
    const r = computePricing(10000, null, rates, 0.2);
    expect(r).toMatchObject({ status: "sin_costo", floorPrice: null, suggestedPrice: null, margin: null });
  });

  it("puede dejar afuera la publicidad", () => {
    const r = computePricing(10000, 5500, rates, 0.2, { includeAds: false });
    expect(r.variableRate).toBeCloseTo(0.23);
  });

  it("si las tasas más el margen pasan el 100%, no hay sugerido posible", () => {
    const r = computePricing(10000, 5500, rates, 0.8);
    expect(r.suggestedPrice).toBeNull();
  });

  it("el sugerido deja al menos el margen objetivo", () => {
    const r = computePricing(10000, 5500, rates, 0.2);
    expect(marginAt(r.suggestedPrice!, 5500, rates)).toBeGreaterThanOrEqual(0.2);
  });
});

describe("roundUpTo10", () => {
  it("redondea hacia arriba", () => {
    expect(roundUpTo10(10901)).toBe(10910);
    expect(roundUpTo10(10900)).toBe(10900);
  });
});
