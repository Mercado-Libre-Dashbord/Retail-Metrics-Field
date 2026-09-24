import { describe, it, expect } from "vitest";
import { acosMetrics, recommendAdsAction } from "./ads-recommendation";

describe("acosMetrics", () => {
  it("calcula ACOS, ACOS de equilibrio y tope de Ads sobre la facturación del producto", () => {
    // Facturó 100.000, gastó 10.000 en Ads y quedó 5.000 de ganancia neta:
    // sin Ads habría dejado 15.000 → aguanta hasta 15% de ACOS.
    const m = acosMetrics(100_000, 5_000, 10_000);
    expect(m.acos).toBeCloseTo(0.1);
    expect(m.breakevenAcos).toBeCloseTo(0.15);
    expect(m.maxAdSpend).toBe(15_000);
  });

  it("marca ACOS por encima del equilibrio cuando la publicidad se come la ganancia (caso bandeja)", () => {
    const m = acosMetrics(71_390, -3_470, 6_831);
    expect(m.acos!).toBeGreaterThan(m.breakevenAcos!);
    expect(m.maxAdSpend).toBeCloseTo(3_361);
    expect(recommendAdsAction(-3_470, 6_831)).toBe("pausar");
  });

  it("da ACOS de equilibrio negativo y tope 0 si el producto pierde aun sin Ads", () => {
    const m = acosMetrics(12_591, -6_324, 445);
    expect(m.breakevenAcos!).toBeLessThan(0);
    expect(m.maxAdSpend).toBe(0);
  });

  it("sin facturación no inventa porcentajes", () => {
    expect(acosMetrics(0, 0, 0)).toEqual({ acos: null, breakevenAcos: null, maxAdSpend: 0 });
  });
});
