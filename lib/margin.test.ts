import { describe, it, expect } from "vitest";
import { computeProductMargin, saleFeeAtPrice } from "./margin";

const base = { otherTaxRate: 0, appliesIva: false, realized: null, estimate: null };

describe("computeProductMargin", () => {
  it("el caso de la captura: $87.000 con costo $22.620 ya no da 74% si ML cobra comisión y envío", () => {
    const m = computeProductMargin({
      ...base,
      currentPrice: 87000,
      currentCost: 22620,
      estimate: { price: 87000, saleFee: 13050, fixedFee: 0, shippingCost: 12000 },
    })!;
    expect(m.kind).toBe("estimado");
    expect(m.perUnit.net).toBe(87000 - 13050 - 12000 - 22620);
    expect(m.pct).toBeCloseTo((87000 - 13050 - 12000 - 22620) / 87000);
    expect(m.pct).toBeLessThan(0.74);
  });

  it("con ventas en el período usa lo que pasó de verdad (real), no la estimación", () => {
    const m = computeProductMargin({
      ...base,
      currentPrice: 5841,
      currentCost: 3565,
      estimate: { price: 5841, saleFee: 2000, fixedFee: 0, shippingCost: 0 },
      realized: { units: 12, revenue: 71390, commission: 25248, shipping: 0, ads: 6831, cost: 42780, taxes: 0, iva: 0, net: -3470, linesWithoutCost: 0 },
    })!;
    expect(m.kind).toBe("real");
    expect(m.pct).toBeCloseTo(-3470 / 71390);
    expect(m.perUnit.ads).toBeCloseTo(6831 / 12);
  });

  it("no usa ventas con líneas sin costo como margen real", () => {
    const m = computeProductMargin({
      ...base,
      currentPrice: 1000,
      currentCost: 400,
      realized: { units: 2, revenue: 2000, commission: 0, shipping: 0, ads: 0, cost: 400, taxes: 0, iva: 0, net: 600, linesWithoutCost: 1 },
      estimate: { price: 1000, saleFee: 150, fixedFee: 0, shippingCost: 0 },
    })!;
    expect(m.kind).toBe("estimado");
  });

  it("descuenta IVA y otros impuestos en el estimado igual que en cada venta", () => {
    const m = computeProductMargin({
      currentPrice: 12100,
      currentCost: 4840,
      otherTaxRate: 0.03,
      appliesIva: true,
      realized: null,
      estimate: { price: 12100, saleFee: 1815, fixedFee: 0, shippingCost: 0 },
    })!;
    // IVA = 21/121 × (12100 − 1815 − 4840) = 945
    expect(m.perUnit.iva).toBeCloseTo(945);
    expect(m.perUnit.taxes).toBeCloseTo(363);
    expect(m.perUnit.net).toBeCloseTo(12100 - 1815 - 4840 - 363 - 945);
  });

  it("avisa cuando al estimado le falta el dato del envío", () => {
    const m = computeProductMargin({ ...base, currentPrice: 50000, currentCost: 10000, estimate: { price: 50000, saleFee: 7000, fixedFee: 0, shippingCost: null } })!;
    expect(m.missingShipping).toBe(true);
  });

  it("sin estimación todavía, cae al margen bruto y lo marca como tal", () => {
    const m = computeProductMargin({ ...base, currentPrice: 1000, currentCost: 400 })!;
    expect(m.kind).toBe("bruto");
    expect(m.pct).toBeCloseTo(0.6);
  });

  it("sin costo no hay margen", () => {
    expect(computeProductMargin({ ...base, currentPrice: 1000, currentCost: null })).toBeNull();
  });
});

describe("saleFeeAtPrice", () => {
  it("usa el cargo estimado tal cual si el precio no cambió", () => {
    expect(saleFeeAtPrice({ price: 5000, saleFee: 1800, fixedFee: 1095, shippingCost: 0 }, 5000)).toBe(1800);
  });

  it("si el precio cambió, reescala la parte porcentual y conserva la fija", () => {
    // 1800 − 1095 = 705 variable sobre 5000 = 14,1% → a 6000: 846 + 1095.
    expect(saleFeeAtPrice({ price: 5000, saleFee: 1800, fixedFee: 1095, shippingCost: 0 }, 6000)).toBeCloseTo(1941);
  });
});
