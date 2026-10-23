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

const text = (obj: unknown, finish_reason = "stop") => ({ choices: [{ finish_reason, message: { content: JSON.stringify(obj) } }] });

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
  it("puts rules and seller info in the system turn and the buyer question in the user turn", () => {
    const req = buildRequest({ question: "¿Entra una notebook de 15?", item, sellerInfo: "Despachamos en 24 h hábiles." }, "llama-3.3-70b-versatile");
    expect(req.messages[0].role).toBe("system");
    expect(req.messages[0].content).toContain("Despachamos en 24 h");
    expect(req.messages[0].content).toContain("JSON");
    expect(req.messages[1].content).toContain("<pregunta>\n¿Entra una notebook de 15?\n</pregunta>");
    expect(req.response_format).toEqual({ type: "json_object" });
    expect(req.model).toBe("llama-3.3-70b-versatile");
  });

  it("tells the model when the seller has not loaded any info", () => {
    const req = buildRequest({ question: "x", item, sellerInfo: "  " });
    expect(req.messages[0].content).toContain("todavía no cargó");
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
    expect(() => parseDraft({ choices: [{ message: { content: null, refusal: "no" } }] })).toThrow(AiDraftError);
    expect(() => parseDraft(text({}, "length"))).toThrow(AiDraftError);
    expect(() => parseDraft({ choices: [{ finish_reason: "stop", message: { content: "no json" } }] })).toThrow(AiDraftError);
    expect(() => parseDraft({})).toThrow(AiDraftError);
  });

  it("accepts JSON wrapped in a code fence", () => {
    const body = { choices: [{ finish_reason: "stop", message: { content: '```json\n{"answer":"¡Hola! Sí. ¡Saludos!","confident":true,"missing":""}\n```' } }] };
    expect(parseDraft(body).confident).toBe(true);
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
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

  it("posts to the OpenAI-compatible endpoint and parses the result", async () => {
    process.env.AI_API_KEY = "k";
    const doFetch = vi.fn().mockResolvedValue(ok(text({ answer: "¡Hola! No sabemos. ¡Saludos!", confident: false, missing: "Medidas exactas" })));
    const draft = await aiDraftAnswer({ question: "¿Medidas?", item, sellerInfo: "" }, doFetch);
    expect(doFetch).toHaveBeenCalledOnce();
    const [url, init] = doFetch.mock.calls[0];
    expect(url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(init.headers.Authorization).toBe("Bearer k");
    expect(draft).toEqual({ answer: "¡Hola! No sabemos. ¡Saludos!", confident: false, missing: "Medidas exactas" });
    delete process.env.AI_API_KEY;
  });

  it("retries once on the free-tier rate limit, then explains it", async () => {
    const limited = () => new Response("", { status: 429, headers: { "retry-after": "0.01" } });
    const doFetch = vi.fn().mockResolvedValueOnce(limited()).mockResolvedValueOnce(ok(text({ answer: "¡Hola! Sí. ¡Saludos!", confident: true, missing: "" })));
    expect((await aiDraftAnswer({ question: "x", item, sellerInfo: "" }, doFetch)).confident).toBe(true);
    const always = vi.fn().mockImplementation(async () => limited());
    await expect(aiDraftAnswer({ question: "x", item, sellerInfo: "" }, always)).rejects.toThrow("límite gratuito");
  });
});
