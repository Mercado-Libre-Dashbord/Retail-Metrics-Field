import { describe, it, expect } from "vitest";
import { parseTrialRequest } from "./trial-request";

const valid = { name: "  Laura   Gómez ", email: " Laura@Tienda.com.ar ", store: "Lámparas Norte" };

describe("parseTrialRequest", () => {
  it("normaliza espacios y pasa el email a minúsculas", () => {
    const r = parseTrialRequest(valid);
    expect(r).toMatchObject({ ok: true, data: { name: "Laura Gómez", email: "laura@tienda.com.ar", store: "Lámparas Norte" } });
  });

  it("guarda las utm de la campaña", () => {
    const r = parseTrialRequest({ ...valid, utmSource: "mail", utmCampaign: "ola1", utmContent: "hookA" });
    expect(r).toMatchObject({ ok: true, data: { utmSource: "mail", utmCampaign: "ola1", utmContent: "hookA" } });
  });

  it("rechaza sin nombre, email inválido o sin tienda", () => {
    expect(parseTrialRequest({ ...valid, name: " " }).ok).toBe(false);
    expect(parseTrialRequest({ ...valid, email: "laura@" }).ok).toBe(false);
    expect(parseTrialRequest({ ...valid, store: "" }).ok).toBe(false);
    expect(parseTrialRequest(null).ok).toBe(false);
  });

  it("detecta el campo trampa de bots", () => {
    expect(parseTrialRequest({ ...valid, website: "http://spam.example" })).toEqual({ ok: "bot" });
  });

  it("descarta valores fuera de lista y teléfonos sin forma de teléfono", () => {
    const r = parseTrialRequest({ ...valid, monthlySales: "un millón", phone: "<script>" });
    expect(r).toMatchObject({ ok: true, data: { monthlySales: null, phone: null } });
    const ok = parseTrialRequest({ ...valid, monthlySales: "50 a 200", phone: "+54 9 351 555-1234" });
    expect(ok).toMatchObject({ ok: true, data: { monthlySales: "50 a 200", phone: "+54 9 351 555-1234" } });
  });

  it("recorta textos largos", () => {
    const r = parseTrialRequest({ ...valid, store: "x".repeat(500), referrer: "y".repeat(1000) });
    if (r.ok !== true) throw new Error("debería ser válido");
    expect(r.data.store.length).toBe(120);
    expect(r.data.referrer?.length).toBe(300);
  });
});
