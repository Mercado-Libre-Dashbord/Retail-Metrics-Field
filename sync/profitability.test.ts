import { describe, it, expect } from "vitest";
import { getCostEntryAtDate, allocateAdsCost, calculateNetProfit, calculateIva } from "./profitability";

describe("getCostEntryAtDate", () => {
  it("returns null when no cost entries exist", () => {
    expect(getCostEntryAtDate([], "2026-01-01")).toBeNull();
  });

  it("returns the most recent cost/tax valid on or before the date", () => {
    const costs = [
      { cost: 100, tax: 10, validFrom: "2026-01-01" },
      { cost: 120, tax: 15, validFrom: "2026-03-01" },
    ];
    expect(getCostEntryAtDate(costs, "2026-02-15")).toEqual({ cost: 100, tax: 10 });
    expect(getCostEntryAtDate(costs, "2026-03-15")).toEqual({ cost: 120, tax: 15 });
  });

  it("falls back to the earliest known entry when it was loaded after the sale date", () => {
    // Cargar el primer costo de un producto no debería dejar sin dato a las
    // ventas históricas anteriores a esa carga — usamos la mejor estimación
    // disponible en vez de null.
    const costs = [{ cost: 100, tax: 10, validFrom: "2026-03-01" }];
    expect(getCostEntryAtDate(costs, "2026-01-01")).toEqual({ cost: 100, tax: 10 });
  });

  it("still prefers an entry valid on or before the date over the earliest one", () => {
    const costs = [
      { cost: 100, tax: 10, validFrom: "2026-03-01" },
      { cost: 80, tax: 5, validFrom: "2025-01-01" },
    ];
    expect(getCostEntryAtDate(costs, "2025-06-01")).toEqual({ cost: 80, tax: 5 });
  });

  it("picks the latest entry when two share the same validFrom date", () => {
    const costs = [
      { cost: 100, tax: 10, validFrom: "2026-01-01" },
      { cost: 150, tax: 20, validFrom: "2026-01-01" },
    ];
    expect(getCostEntryAtDate(costs, "2026-01-01")).toEqual({ cost: 150, tax: 20 });
  });
});

describe("allocateAdsCost", () => {
  it("returns 0 when no units were sold that day", () => {
    expect(allocateAdsCost(500, 0, 1)).toBe(0);
  });

  it("prorates spend proportionally to units in this line", () => {
    expect(allocateAdsCost(500, 5, 2)).toBe(200);
  });

  it("returns the full spend when this line is the only unit sold", () => {
    expect(allocateAdsCost(500, 1, 1)).toBe(500);
  });
});

describe("calculateNetProfit", () => {
  it("returns null when no cost was applied", () => {
    const result = calculateNetProfit({
      unitPrice: 1000,
      quantity: 1,
      mlCommission: 130,
      shippingCost: 90,
      adsCostAllocated: 50,
      costApplied: null,
      taxApplied: null,
      appliesIva: true,
    });
    expect(result).toBeNull();
  });

  it("computes net profit subtracting all costs, the manual tax and IVA", () => {
    const input = {
      unitPrice: 1000,
      quantity: 2,
      mlCommission: 130,
      shippingCost: 90,
      adsCostAllocated: 50,
      costApplied: 300,
      taxApplied: 20,
      appliesIva: true,
    };
    // Bruto 2000 − 130 − 90 − 50 − 600 de costo − 40 de impuesto manual = 1090,
    // y de ahí sale además el saldo de IVA (débito de la venta menos crédito
    // de los cargos de ML y del costo).
    const result = calculateNetProfit(input);
    expect(result).toBeCloseTo(1090 - calculateIva(input));
    expect(result).toBeLessThan(1090);
  });

  it("treats a null tax as 0", () => {
    const input = {
      unitPrice: 1000,
      quantity: 2,
      mlCommission: 130,
      shippingCost: 90,
      adsCostAllocated: 50,
      costApplied: 300,
      taxApplied: null,
      appliesIva: true,
    };
    expect(calculateNetProfit(input)).toBeCloseTo(1130 - calculateIva(input));
  });

  it("no descuenta IVA para una cuenta que no factura con IVA discriminado", () => {
    // El caso real que lo motivó: un vendedor Monotributista. El precio de
    // Mercado Libre no "incluye" un IVA que haya que separarle — restándoselo
    // igual, un vendedor con 39% de rentabilidad real aparecía con bastante
    // menos.
    const conIva = calculateNetProfit({
      unitPrice: 1000, quantity: 2, mlCommission: 130, shippingCost: 90,
      adsCostAllocated: 50, costApplied: 300, taxApplied: 20, appliesIva: true,
    });
    const sinIva = calculateNetProfit({
      unitPrice: 1000, quantity: 2, mlCommission: 130, shippingCost: 90,
      adsCostAllocated: 50, costApplied: 300, taxApplied: 20, appliesIva: false,
    });
    expect(sinIva).toBeCloseTo(1090); // sin el saldo de IVA restado
    expect(sinIva).toBeGreaterThan(conIva!);
  });
});

describe("calculateIva", () => {
  it("charges IVA on the margin, not on the whole sale", () => {
    const iva = calculateIva({
      unitPrice: 1210,
      quantity: 1,
      mlCommission: 121,
      shippingCost: 0,
      adsCostAllocated: 0,
      costApplied: 605,
      taxApplied: null,
      appliesIva: true,
    });
    // Débito 210 − crédito (21 de comisión + 105 del costo).
    expect(iva).toBeCloseTo(210 - 21 - 105);
  });

  it("treats a missing cost as no IVA credit rather than crashing", () => {
    const iva = calculateIva({
      unitPrice: 1210,
      quantity: 1,
      mlCommission: 0,
      shippingCost: 0,
      adsCostAllocated: 0,
      costApplied: null,
      taxApplied: null,
      appliesIva: true,
    });
    expect(iva).toBeCloseTo(210);
  });

  it("es cero, sin calcular nada, para Monotributo o exento", () => {
    const iva = calculateIva({
      unitPrice: 1210,
      quantity: 1,
      mlCommission: 121,
      shippingCost: 0,
      adsCostAllocated: 0,
      costApplied: 605,
      taxApplied: null,
      appliesIva: false,
    });
    expect(iva).toBe(0);
  });
});
