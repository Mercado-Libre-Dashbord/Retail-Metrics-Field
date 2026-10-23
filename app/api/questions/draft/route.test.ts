import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const query = vi.fn();
vi.mock("@/db/client", () => ({ withScope: vi.fn((ctx: unknown, fn: (client: unknown) => unknown) => fn({ query })) }));
vi.mock("@/db/schema-capabilities", () => ({ hasColumn: vi.fn().mockResolvedValue(true) }));
vi.mock("@/lib/current-account", () => ({ resolveCurrentAccount: vi.fn() }));
vi.mock("@/mcp/tools", () => ({ getItemKnowledge: vi.fn() }));
vi.mock("@/lib/answer-ai", async (orig) => ({ ...(await orig<typeof import("@/lib/answer-ai")>()), aiDraftAnswer: vi.fn() }));

import { POST } from "./route";
import { resolveCurrentAccount } from "@/lib/current-account";
import { getItemKnowledge } from "@/mcp/tools";
import { aiDraftAnswer, AiDraftError } from "@/lib/answer-ai";

const account = { id: "acc1", name: "Cuenta", ownerEmail: "a@example.com", mlSellerId: "S1", otherTaxRate: 0, taxCondition: "responsable_inscripto" as const, taxConditionConfirmed: true, createdAt: "2026-01-01" };
const req = (body: unknown) => new Request("http://x/api/questions/draft", { method: "POST", body: JSON.stringify(body) }) as any;

describe("POST /api/questions/draft", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AI_API_KEY = "test";
    vi.mocked(resolveCurrentAccount).mockResolvedValue(account);
    vi.mocked(getItemKnowledge).mockResolvedValue({ title: "Item" } as any);
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM answer_settings")) return { rows: [{ seller_info: "Factura A y B" }] };
      if (sql.includes("FROM question_drafts")) {
        return { rows: [
          { ml_question_id: "1", product_id: "MLA1", question_text: "¿Hacen factura A?" },
          { ml_question_id: "2", product_id: "MLA1", question_text: "¿Medidas?" },
        ] };
      }
      return { rows: [] };
    });
  });
  afterEach(() => { delete process.env.AI_API_KEY; });

  it("returns 503 when the API key is not configured", async () => {
    delete process.env.AI_API_KEY;
    const res = await POST(req({}));
    expect(res.status).toBe(503);
  });

  it("drafts each pending question, fetching the listing once, and saves the successes", async () => {
    vi.mocked(aiDraftAnswer)
      .mockResolvedValueOnce({ answer: "¡Hola! Sí. ¡Saludos!", confident: true, missing: "" })
      .mockRejectedValueOnce(new AiDraftError("La IA no quiso responder esta consulta."));
    const res = await POST(req({}));
    const body = await res.json();
    expect(getItemKnowledge).toHaveBeenCalledTimes(1);
    expect(vi.mocked(aiDraftAnswer).mock.calls[0][0].sellerInfo).toBe("Factura A y B");
    expect(body.results).toHaveLength(2);
    expect(body.results.filter((r: any) => r.ok)).toHaveLength(1);
    expect(body.results.find((r: any) => !r.ok).error).toContain("no quiso");
    const updates = query.mock.calls.filter(([sql]) => String(sql).startsWith("UPDATE question_drafts"));
    expect(updates).toHaveLength(1);
    expect(updates[0][1]).toEqual(["¡Hola! Sí. ¡Saludos!", true, null, "acc1", expect.any(String)]);
    expect(body.more).toBe(false);
  });

  it("only drafts the requested ids when given", async () => {
    vi.mocked(aiDraftAnswer).mockResolvedValue({ answer: "ok", confident: false, missing: "Medidas" });
    await POST(req({ mlQuestionIds: [2, "x"] }));
    const select = query.mock.calls.find(([sql]) => String(sql).includes("FROM question_drafts"))!;
    expect(select[1][1]).toEqual([2]);
  });
});
