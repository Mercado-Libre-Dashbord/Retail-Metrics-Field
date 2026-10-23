import { describe, it, expect } from "vitest";
import { adviseAd, adviseCandidate, buildAdvice, daysBetween } from "./ads-advisor";

const ad = (spend: number, adRevenue: number, breakevenAcos: number | null) => ({ productId: "P", title: "T", spend, adRevenue, adUnits: 1, breakevenAcos });

describe("adviseAd (30 días)", () => {
  it("sube el presupuesto cuando el ACOS está muy por debajo del margen, de a +50% como mucho", () => {
    // ACOS 10%, margen 40% → objetivo 24% → 2,4x, pero se sube 1,5x.
    const r = adviseAd(ad(30000, 300000, 0.4), 30);
    expect(r.action).toBe("subir");
    expect(r.currentDaily).toBe(1000);
    expect(r.suggestedDaily).toBe(1500);
  });
  it("mantiene cuando gana pero está cerca del objetivo", () => {
    expect(adviseAd(ad(30000, 100000, 0.4), 30).action).toBe("mantener"); // ACOS 30%, objetivo 24%
  });
  it("baja hasta el ACOS objetivo cuando pasa un poco el equilibrio", () => {
    // ACOS 50%, margen 40% → objetivo 24%: 1000/día × 24/50 = 480 → 500.
    const r = adviseAd(ad(30000, 60000, 0.4), 30);
    expect(r.action).toBe("bajar");
    expect(r.suggestedDaily).toBe(500);
    expect(r.adsProfit).toBe(60000 * 0.4 - 30000);
  });
  it("pausa cuando el ACOS pasa 1,5 veces el equilibrio o no vendió nada", () => {
    expect(adviseAd(ad(30000, 40000, 0.4), 30)).toMatchObject({ action: "pausar", suggestedDaily: 0 }); // 75%
    expect(adviseAd(ad(5000, 0, 0.4), 30)).toMatchObject({ action: "pausar", suggestedDaily: 0 });
  });
  it("sin margen: revisar precio; sin costo: no sugiere", () => {
    expect(adviseAd(ad(1000, 10000, -0.05), 30).action).toBe("revisar_precio");
    expect(adviseAd(ad(1000, 10000, null), 30)).toMatchObject({ action: "sin_costo", suggestedDaily: null });
  });
});

describe("candidatos sin publicidad", () => {
  it("sugiere probar con lo que justifica una venta más por día", () => {
    // Precio 20.000, margen 30% → objetivo 18% → $3.600/día.
    const r = adviseCandidate({ productId: "C", title: "C", units: 10, revenue: 200000, marginBeforeAds: 0.3 })!;
    expect(r.action).toBe("probar");
    expect(r.suggestedDaily).toBe(3600);
  });
  it("no sugiere productos con poco margen, pocas ventas o sin costo", () => {
    expect(adviseCandidate({ productId: "C", title: "C", units: 10, revenue: 100000, marginBeforeAds: 0.1 })).toBeNull();
    expect(adviseCandidate({ productId: "C", title: "C", units: 2, revenue: 100000, marginBeforeAds: 0.4 })).toBeNull();
    expect(adviseCandidate({ productId: "C", title: "C", units: 10, revenue: 100000, marginBeforeAds: null })).toBeNull();
  });
});

describe("buildAdvice", () => {
  it("ordena por urgencia y calcula la pérdida mensual de lo que hay que pausar o bajar", () => {
    const s = buildAdvice(
      [
        { productId: "A", title: "A", spend: 15000, adRevenue: 300000, adUnits: 5, breakevenAcos: 0.4 },
        { productId: "B", title: "B", spend: 15000, adRevenue: 20000, adUnits: 1, breakevenAcos: 0.3 },
      ],
      [{ productId: "C", title: "C", units: 10, revenue: 200000, marginBeforeAds: 0.3 }],
      15
    );
    expect(s.items.map((i) => [i.productId, i.action])).toEqual([["B", "pausar"], ["A", "subir"], ["C", "probar"]]);
    // B: 20.000 × 0,3 − 15.000 = −9.000 en 15 días → −18.000 por mes.
    expect(s.monthlyLoss).toBe(18000);
    expect(daysBetween("2026-10-01", "2026-10-15")).toBe(15);
  });
});
