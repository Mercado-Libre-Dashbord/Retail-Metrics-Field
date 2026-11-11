import { describe, it, expect } from "vitest";
import { businessDateStr } from "./dates";
import { toDateStr } from "./period";

describe("businessDateStr", () => {
  it("una venta de las 21:30 de Argentina es de ese día, no del siguiente", () => {
    // 2026-08-05 00:30 UTC = 2026-08-04 21:30 en Argentina.
    expect(businessDateStr("2026-08-05T00:30:00Z")).toBe("2026-08-04");
    expect(businessDateStr(new Date("2026-08-05T03:00:00Z"))).toBe("2026-08-05");
  });

  it("la última venta del mes no se pasa al mes siguiente", () => {
    expect(businessDateStr("2026-09-01T02:59:59Z")).toBe("2026-08-31");
  });
});

describe("toDateStr", () => {
  it("usa el día local de quien mira, no el de UTC", () => {
    const d = new Date(2026, 7, 4, 22, 30); // 4 de agosto, 22:30 hora local
    expect(toDateStr(d)).toBe("2026-08-04");
  });
});
