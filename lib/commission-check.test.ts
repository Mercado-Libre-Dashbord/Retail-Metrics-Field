import { describe, it, expect } from "vitest";
import { interpretCommissionCheck } from "./commission-check";

const base = { orders: 40, billed: 100_000, calculated: 100_000, ratio: 1, multiUnitOrders: 0, multiUnitRatio: null, ivaIsCost: true };

describe("interpretCommissionCheck", () => {
  it("ok cuando lo facturado y lo calculado coinciden", () => {
    expect(interpretCommissionCheck(base).status).toBe("ok");
  });

  it("detecta IVA encima de la comisión y lo marca como costo para un monotributista", () => {
    const v = interpretCommissionCheck({ ...base, billed: 121_000, ratio: 1.21 });
    expect(v.status).toBe("iva");
    expect(v.detail).toContain("es un costo");
  });

  it("para un Responsable Inscripto ese IVA es crédito fiscal, no costo", () => {
    const v = interpretCommissionCheck({ ...base, billed: 121_000, ratio: 1.21, ivaIsCost: false });
    expect(v.detail).toContain("crédito fiscal");
  });

  it("señala ventas de varias unidades cuando son lo único que no cierra", () => {
    const v = interpretCommissionCheck({ ...base, multiUnitOrders: 3, multiUnitRatio: 2 });
    expect(v.status).toBe("multi_unit");
  });

  it("cualquier otra diferencia se muestra tal cual, sin inventar la causa", () => {
    expect(interpretCommissionCheck({ ...base, billed: 90_000, ratio: 0.9 }).status).toBe("diff");
  });
});
