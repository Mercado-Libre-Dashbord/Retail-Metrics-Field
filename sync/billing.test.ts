import { describe, it, expect } from "vitest";
import { classifyCharge, classifyFullChargeDetail, MANUAL_DETAIL_TYPE, manualSubType } from "./billing";

describe("classifyCharge", () => {
  it("recognises tax perceptions and withholdings", () => {
    expect(classifyCharge("Percepción IVA RG 4310")).toBe("impuesto");
    expect(classifyCharge("Retención IIBB Buenos Aires")).toBe("impuesto");
    expect(classifyCharge(null, "TAX", "Ingresos Brutos")).toBe("impuesto");
  });

  it("recognises shipping charges", () => {
    expect(classifyCharge("Mercado Envios charge")).toBe("envio");
    expect(classifyCharge("Cargo de envío")).toBe("envio");
  });

  it("recognises advertising charges", () => {
    expect(classifyCharge("Advertising campaigns - Product Ads")).toBe("publicidad");
  });

  it("recognises sales commission", () => {
    expect(classifyCharge("Sales charge")).toBe("comision");
    expect(classifyCharge("Comisión por venta")).toBe("comision");
  });

  it("prefers the tax bucket when a charge mentions both a tax and a sale", () => {
    // "Percepción IVA sobre comisión de venta" es un impuesto, no una comisión.
    expect(classifyCharge("Percepción IVA sobre comisión de venta")).toBe("impuesto");
  });

  it("keeps unknown concepts as 'otro' instead of dropping them", () => {
    expect(classifyCharge("Cargo por servicio raro nuevo")).toBe("otro");
    expect(classifyCharge(null, undefined)).toBe("otro");
  });

  it("una penalidad de incumplimiento de envíos no es un costo de envío", () => {
    // Es el bug real que encontramos cruzando el reporte de un cliente: esta
    // frase contiene "envíos" y caía en el bucket de flete, inflándolo, y
    // escondiendo que en realidad es una multa por Full.
    expect(classifyCharge("Incumplimiento Envíos Full")).toBe("otro");
    expect(classifyCharge("Penalidad por demora en despacho")).toBe("otro");
  });

  it("separa los cargos de Mercado Envíos Full del flete de venta", () => {
    // Mismo tipo de bug que el de incumplimiento: "Envío a Fulfillment" o
    // "Retiro de stock Full" contienen la palabra "envío" y caían en el
    // bucket de flete de venta, mezclando el costo de guardar stock con el
    // de mandarle el pedido al comprador.
    expect(classifyCharge("Envío a depósito Full")).toBe("full");
    expect(classifyCharge("Retiro de stock Full")).toBe("full");
    expect(classifyCharge("Almacenamiento Full - Septiembre")).toBe("full");
    expect(classifyCharge(null, "FULFILLMENT_STORAGE_FEE")).toBe("full");
    expect(classifyCharge("Cargo por stock antiguo")).toBe("full");
  });

  it("reconoce los códigos cortos de detail_sub_type de Full, sin depender del texto", () => {
    // Sin confirmar todavía contra una respuesta real de la API — si el
    // nombre real es otro, este exact-match nunca dispara y el cargo sigue
    // clasificándose por el detector de texto de siempre, sin romper nada.
    expect(classifyCharge(null, "CHARGE", "FBM_STORAGE")).toBe("full");
    expect(classifyCharge(null, "CHARGE", "fbm_long_term_storage")).toBe("full");
    expect(classifyCharge(null, "CHARGE", "FBM_STOCK_REMOVAL")).toBe("full");
  });
});

describe("classifyFullChargeDetail", () => {
  it("reconoce los códigos cortos de detail_sub_type", () => {
    expect(classifyFullChargeDetail("FBM_STORAGE")).toBe("almacenamiento");
    expect(classifyFullChargeDetail("FBM_LONG_TERM_STORAGE")).toBe("stock_antiguo");
    expect(classifyFullChargeDetail("fbm_stock_removal")).toBe("retiro");
  });

  it("distingue stock antiguo de almacenamiento normal por texto", () => {
    // "Permanencia prolongada" suele venir junto con la palabra
    // "almacenamiento" en la misma descripción — antigüedad tiene que ganar,
    // porque es la penalidad, no el costo de guarda de todos los días.
    expect(classifyFullChargeDetail("Almacenamiento por permanencia prolongada")).toBe("stock_antiguo");
    expect(classifyFullChargeDetail("Cargo por almacenamiento diario")).toBe("almacenamiento");
  });

  it("reconoce el retiro y el envío del stock al depósito", () => {
    expect(classifyFullChargeDetail("Retiro de stock Full")).toBe("retiro");
    expect(classifyFullChargeDetail("Envío a depósito Full")).toBe("envio_a_full");
  });

  it("cae en 'otro' cuando no reconoce el concepto", () => {
    expect(classifyFullChargeDetail("Cargo de Full sin descripción clara")).toBe("otro");
    expect(classifyFullChargeDetail(null, undefined)).toBe("otro");
  });
});

describe("manual charges", () => {
  it("keeps the concept the seller picked, ignoring keywords in the description", () => {
    // La descripción dice "envío" pero el vendedor eligió comisión.
    expect(classifyCharge("Factura por envío A-123", MANUAL_DETAIL_TYPE, manualSubType("comision"))).toBe("comision");
    expect(classifyCharge(null, MANUAL_DETAIL_TYPE, manualSubType("full"))).toBe("full");
  });

  it("falls back to keyword detection for an unknown manual bucket", () => {
    expect(classifyCharge("Percepción IVA", MANUAL_DETAIL_TYPE, "manual:inexistente")).toBe("impuesto");
  });
});
