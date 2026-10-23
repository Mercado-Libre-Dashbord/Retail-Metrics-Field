import { describe, it, expect, vi } from "vitest";
import { buildRequest, parseDraft, enforcePolicy, describeItem, aiDraftAnswer, AiDraftError, ML_ANSWER_MAX } from "./answer-ai";
import type { ItemKnowledge } from "@/mcp/tools";

const item: ItemKnowledge = {
  title: "Mochila urbana 25 L",
  price: 45999,
  currency: "ARS",
  stock: 12,
  condition: "new",
  freeShipping: true,
  logisticType: "fulfillment",
  saleTerms: ["Garantía: 6 meses"],
  attributes: ["Marca: Casa Norte", "Capacidad: 25 L"],
  variations: ["Color: Negro (8 u.)", "Color: Gris (4 u.)"],
  description: "Mochila con bolsillo para notebook de hasta 15,6 pulgadas.",
  pastAnswers: [{ question: "¿Es impermeable?", answer: "¡Hola! Es resistente al agua, no sumergible. ¡Saludos!" }],
};

const text = (obj: unknown, stop_reason = "end_turn") => ({ stop_reason, content: [{ type: "text", text: JSON.stringify(obj) }] });

describe("describeItem", () => {
  it("includes the listing data, description and past answers", () => {
    const d = describeItem(item);
    expect(d).toContain("Mochila urbana 25 L");
    expect(d).toContain("12 unidades");
    expect(d).toContain("Garantía: 6 meses");
    expect(d).toContain("Color: Gris (4 u.)");
    expect(d).toContain("notebook de hasta 15,6");
    expect(d).toContain("P: ¿Es impermeable?");
    expect(d).toContain("Full");
  });

  it("says when there is no stock", () => {
    expect(describeItem({ ...item, stock: 0 })).toContain("sin stock");
  });
});

describe("buildRequest", () => {
  it("caches the stable prefix and keeps the buyer question in the user turn", () => {
    const req = buildRequest({ question: "¿Entra una notebook de 15?", item, sellerInfo: "Despachamos en 24 h hábiles." }, "claude-opus-5-5");
    expect(req.system[1].cache_control).toEqual({ type: "ephemeral" });
    expect(req.system[1].text).toContain("Despachamos en 24 h");
    expect(req.messages[0].content).toContain("<pregunta>\n¿Entra una notebook de 15?\n</pregunta>");
    expect(req.output_config.format.type).toBe("json_schema");
    expect(req.fallbacks).toBe("default");
  });

  it("tells the model when the seller has not loaded any info", () => {
    const req = buildRequest({ question: "x", item, sellerInfo: "  " });
    expect(req.system[1].text).toContain("todavía no cargó");
  });
});

describe("parseDraft", () => {
  it("returns the structured draft", () => {
    expect(parseDraft(text({ answer: "¡Hola! Sí, entra. ¡Saludos!", confident: true, missing: "" }))).toEqual({
      answer: "¡Hola! Sí, entra. ¡Saludos!",
      confident: true,
      missing: "",
    });
  });

  it("throws on refusals and truncated output", () => {
    expect(() => parseDraft({ stop_reason: "refusal", content: [] })).toThrow(AiDraftError);
    expect(() => parseDraft(text({}, "max_tokens"))).toThrow(AiDraftError);
    expect(() => parseDraft({ stop_reason: "end_turn", content: [{ type: "text", text: "no json" }] })).toThrow(AiDraftError);
  });
});

describe("enforcePolicy", () => {
  it("never marks an answer with contact data as safe to send", () => {
    for (const answer of ["Escribime a ventas@tienda.com", "Mirá www.tienda.com.ar", "Llamanos al 11 4567-8901", "Hablame por WhatsApp"]) {
      expect(enforcePolicy({ answer, confident: true, missing: "" }).confident).toBe(false);
    }
  });

  it("clips to the Mercado Libre limit and flags empty answers", () => {
    expect(enforcePolicy({ answer: "a".repeat(3000), confident: true, missing: "" }).answer).toHaveLength(ML_ANSWER_MAX);
    expect(enforcePolicy({ answer: " ", confident: true, missing: "" })).toMatchObject({ confident: false });
  });

  it("drops the missing note on confident answers", () => {
    expect(enforcePolicy({ answer: "¡Hola! Sí. ¡Saludos!", confident: true, missing: "nada" }).missing).toBe("");
  });
});

describe("aiDraftAnswer", () => {
  it("calls the beta messages API and parses the result", async () => {
    const create = vi.fn().mockResolvedValue(text({ answer: "¡Hola! No sabemos. ¡Saludos!", confident: false, missing: "Medidas exactas" }));
    const draft = await aiDraftAnswer({ question: "¿Medidas?", item, sellerInfo: "" }, { beta: { messages: { create } } } as any);
    expect(create).toHaveBeenCalledOnce();
    expect(draft).toEqual({ answer: "¡Hola! No sabemos. ¡Saludos!", confident: false, missing: "Medidas exactas" });
  });
});
