import { describe, it, expect } from "vitest";
import { attributedAdsMetrics } from "./ads-recommendation";

describe("attributedAdsMetrics", () => {
  it("ROAS y ACOS salen de las ventas atribuidas al anuncio", () => {
    const m = attributedAdsMetrics({ spend: 1000, adRevenue: 5000, marginBeforeAds: 0.3 });
    expect(m.roas).toBe(5);
    expect(m.acos).toBeCloseTo(0.2);
    expect(m.adsProfit).toBeCloseTo(5000 * 0.3 - 1000);
    expect(m.recommendation).toBe("mantener"); // 20% está entre la mitad (15%) y el equilibrio (30%)
  });

  it("pausar si el ACOS supera el margen: cada venta por Ads pierde plata", () => {
    expect(attributedAdsMetrics({ spend: 4000, adRevenue: 10000, marginBeforeAds: 0.25 }).recommendation).toBe("pausar");
  });

  it("pausar si gasta y no vendió nada por publicidad", () => {
    const m = attributedAdsMetrics({ spend: 800, adRevenue: 0, marginBeforeAds: 0.4 });
    expect(m.recommendation).toBe("pausar");
    expect(m.acos).toBeNull();
    expect(m.adsProfit).toBe(-800);
  });

  it("aumentar si el ACOS es menos de la mitad del margen", () => {
    expect(attributedAdsMetrics({ spend: 500, adRevenue: 10000, marginBeforeAds: 0.3 }).recommendation).toBe("aumentar");
  });

  it("pausar si el producto pierde aun sin publicidad", () => {
    expect(attributedAdsMetrics({ spend: 100, adRevenue: 10000, marginBeforeAds: -0.05 }).recommendation).toBe("pausar");
  });

  it("sin margen conocido (falta el costo) no recomienda", () => {
    const m = attributedAdsMetrics({ spend: 100, adRevenue: 1000, marginBeforeAds: null });
    expect(m.recommendation).toBe("sin_costo");
    expect(m.adsProfit).toBeNull();
    expect(m.roas).toBe(10);
  });
});
