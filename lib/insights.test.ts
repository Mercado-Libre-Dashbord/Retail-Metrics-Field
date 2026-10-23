import { describe, it, expect } from "vitest";
import { buildInsights, type Breakdown } from "./insights";

const b = (o: Partial<Breakdown>): Breakdown => ({ revenue: 100000, commission: 15000, shipping: 10000, cost: 50000, ads: 3000, taxes: 7000, netProfit: 15000, ...o });
const text = (i: { parts: (string | { strong: string })[] }) => i.parts.map((p) => (typeof p === "string" ? p : p.strong)).join("");
const base = { losing: [], missingCost: { products: 0, units: 0, revenue: 0 }, idleFull: { products: 0, units: 0, capital: 0, top: null }, best: null };

describe("buildInsights", () => {
  it("explica una caída de margen por el costo que más creció", () => {
    const [i] = buildInsights({ ...base, current: b({ shipping: 14000, netProfit: 11000 }), previous: b({}) });
    expect(i.id).toBe("margin");
    expect(i.tone).toBe("neg");
    expect(text(i)).toBe("Tu margen bajó de 15,0% a 11,0% contra el período anterior, sobre todo por el envío (+4 puntos de la facturación).");
  });

  it("no menciona movimientos chicos de margen", () => {
    expect(buildInsights({ ...base, current: b({ netProfit: 14500 }), previous: b({}) })).toEqual([]);
  });

  it("pone primero lo que pierde plata y deja lo bueno al final, cuatro como mucho", () => {
    const out = buildInsights({
      current: b({}),
      previous: null,
      losing: [{ title: "Auriculares", units: 12, profit: -9000 }, { title: "Humidificador", units: 3, profit: -2000 }],
      missingCost: { products: 1, units: 6, revenue: 41940 },
      idleFull: { products: 2, units: 40, capital: 180000, top: "Mochila" },
      best: { title: "Botella Térmica", profit: 6000 },
    });
    expect(out.map((i) => i.id)).toEqual(["losing", "idle-full", "missing-cost", "best"]);
    expect(text(out[0])).toBe("2 productos venden a pérdida: −$11.000 en 15 unidades. El que más pierde es Auriculares (−$9.000).");
    expect(text(out[3])).toBe("Botella Térmica es el que más deja: $6.000, 40% de tu ganancia.");
    expect(out[0].action).toEqual({ label: "Ver productos", href: "/productos" });
  });
});
