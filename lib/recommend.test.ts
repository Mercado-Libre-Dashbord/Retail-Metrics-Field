import { describe, it, expect } from "vitest";
import { recommend, type RecommendInput } from "./recommend";
import { computePricing, type PricingRates } from "./pricing";

// Tasas variables 25% y envío $500 por unidad.
const rates: PricingRates = { commission: 0.15, iva: 0.05, tax: 0.03, ads: 0.02, shippingPerUnit: 500, estimated: false };

function input(price: number, cost: number | null, extra: Partial<RecommendInput> = {}): RecommendInput {
  const p = computePricing(price, cost, rates, 0.2);
  return {
    price, cost, rates, floorPrice: p.floorPrice, suggestedPrice: p.suggestedPrice, unitProfit: p.unitProfit, margin: p.margin,
    unitsSold: 90, days: 90, target: 0.2, ...extra,
  };
}

describe("recommend", () => {
  it("si vende a pérdida, lo primero es subir al sugerido", () => {
    // costo 5500 + envío 500 = 6000 fijo; piso 8000; sugerido 10910
    const r = recommend(input(7000, 5500));
    expect(r.action).toBe("subir_pierde");
    expect(r.targetPrice).toBe(10910);
    expect(r.headline).toContain("Perdés");
    expect(r.monthlyNow).toBeLessThan(0);
    expect(r.monthlyAtTarget).toBeGreaterThan(0);
  });

  it("si vende a pérdida y el objetivo queda muy arriba del mercado, sube solo hasta el mercado", () => {
    // piso 8000, sugerido 10910, el mercado (quien gana) está a 9000
    const r = recommend(input(7000, 5500, { catalog: { status: "competing", priceToWin: 8990, winnerPrice: 9000, missing: [], competitorPrices: [9000] } }));
    expect(r.action).toBe("subir_pierde");
    expect(r.targetPrice).toBe(9000);
    expect(r.headline).toContain("dejás de perder");
  });

  it("si vende a pérdida y ni el mercado cubre el piso, manda a revisar el costo", () => {
    const r = recommend(input(7000, 5500, { reference: { suggestedPrice: 7500, lowestPrice: 7000 } }));
    expect(r.action).toBe("subir_pierde");
    expect(r.headline).toContain("revisá el costo");
    expect(r.targetPrice).toBe(8000);
  });

  it("si pierde el catálogo por precio y el margen aguanta, recomienda bajar al precio para ganar", () => {
    const r = recommend(input(12000, 5000, { catalog: { status: "competing", priceToWin: 11000, winnerPrice: 11050, missing: [], competitorPrices: [11050] } }));
    expect(r.action).toBe("bajar_para_ganar");
    expect(r.targetPrice).toBe(11000);
    expect(r.marginAtTarget).toBeCloseTo(0.25);
  });

  it("no recomienda bajar si para ganar hay que vender bajo el piso", () => {
    const r = recommend(input(12000, 7000, { catalog: { status: "competing", priceToWin: 9000, winnerPrice: 9050, missing: ["Mercado Envíos Full"], competitorPrices: [9050] } }));
    expect(r.action).toBe("no_bajes");
    expect(r.targetPrice).toBeNull();
    expect(r.detail).toContain("Mercado Envíos Full");
  });

  it("si pierde por algo que no es el precio, lo dice", () => {
    const r = recommend(input(11000, 5000, { catalog: { status: "competing", priceToWin: 11000, winnerPrice: 11500, missing: ["envío gratis"], competitorPrices: [11500] } }));
    expect(r.action).toBe("mejorar_condiciones");
    expect(r.headline).toContain("envío gratis");
  });

  it("si gana y el siguiente está bastante más caro, propone subir sin perder el primer puesto", () => {
    const r = recommend(input(10000, 5000, { catalog: { status: "winning", priceToWin: null, winnerPrice: 10000, missing: [], competitorPrices: [11500, 12000] } }));
    expect(r.action).toBe("subir_sin_perder");
    expect(r.targetPrice).toBe(11490);
    expect(r.profitAtTarget!).toBeGreaterThan(r.profitNow!);
  });

  it("fuera de catálogo y bajo el objetivo, sube al sugerido si el mercado lo aguanta", () => {
    const r = recommend(input(10000, 5500, { reference: { suggestedPrice: 12000, lowestPrice: 9800 } }));
    expect(r.action).toBe("subir_al_objetivo");
    expect(r.targetPrice).toBe(10910);
  });

  it("si para el objetivo habría que quedar más caro que el mercado, manda a revisar costos y no sube", () => {
    const r = recommend(input(10000, 5500, { reference: { suggestedPrice: 10200, lowestPrice: 9500 } }));
    expect(r.action).toBe("revisar_costos");
    expect(r.targetPrice).toBeNull();
  });

  it("nunca recomienda un precio por debajo del piso", () => {
    const r = recommend(input(20000, 5000, { reference: { suggestedPrice: 5000, lowestPrice: 4000 } }));
    // piso = (5000 + 500) / 0,75 = 7333
    if (r.targetPrice !== null) expect(r.targetPrice).toBeGreaterThanOrEqual(7333);
    expect(r.action).not.toBe("mas_caro_que_mercado");
  });

  it("sin costo pide cargarlo", () => {
    expect(recommend(input(10000, null)).action).toBe("cargar_costo");
  });

  it("está bien cuando deja el objetivo y no hay nada mejor que hacer", () => {
    expect(recommend(input(12000, 5000)).action).toBe("ok");
  });
});
