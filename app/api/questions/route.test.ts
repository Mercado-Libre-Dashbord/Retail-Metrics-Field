import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/db/client", () => ({ withScope: vi.fn((ctx: unknown, fn: (client: unknown) => unknown) => fn({ query: vi.fn() })) }));
vi.mock("@/lib/current-account", () => ({ resolveCurrentAccount: vi.fn() }));
vi.mock("@/mcp/tools", () => ({ listUnansweredQuestions: vi.fn(), answerQuestion: vi.fn() }));

import { GET, PATCH } from "./route";
import { withScope } from "@/db/client";
import { resolveCurrentAccount } from "@/lib/current-account";
import { listUnansweredQuestions, answerQuestion } from "@/mcp/tools";
import { MlApiError } from "@/mcp/ml-client";

const account = { id: "acc1", name: "Cuenta", ownerEmail: "a@example.com", mlSellerId: "S1", otherTaxRate: 0, taxCondition: "responsable_inscripto" as const, taxConditionConfirmed: true, createdAt: "2026-01-01" };

describe("GET /api/questions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveCurrentAccount).mockResolvedValue(account);
  });

  it("returns 401 when there is no active account", async () => {
    vi.mocked(resolveCurrentAccount).mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("returns 400 when the account has no ML seller connected", async () => {
    vi.mocked(resolveCurrentAccount).mockResolvedValue({ ...account, mlSellerId: null });
    const res = await GET();
    expect(res.status).toBe(400);
  });

  it("upserts fresh questions as drafts and returns the stored list", async () => {
    vi.mocked(listUnansweredQuestions).mockResolvedValue([
      { id: 55, productId: "MLA1", text: "¿Tienen stock?", dateCreated: "2026-01-01T00:00:00Z" },
    ]);
    const query = vi.fn().mockImplementation((sql: string) => {
      if (sql.includes("SELECT current_price")) return { rows: [{ current_price: 100, stock: 5 }] };
      if (sql.includes("INSERT INTO question_drafts")) return { rows: [] };
      return {
        rows: [
          {
            mlquestionid: "55",
            productid: "MLA1",
            producttitle: "Producto 1",
            questiontext: "¿Tienen stock?",
            draftanswer: "Sí, tenemos stock disponible (5 unidades).",
            datecreated: "2026-01-01T00:00:00Z",
          },
        ],
      };
    });
    vi.mocked(withScope).mockImplementation((ctx: any, fn: any) => fn({ query }));

    const res = await GET();
    const body = await res.json();

    expect(body).toEqual([
      {
        mlQuestionId: "55",
        productId: "MLA1",
        productTitle: "Producto 1",
        thumbnail: null,
        questionText: "¿Tienen stock?",
        draftAnswer: "Sí, tenemos stock disponible (5 unidades).",
        dateCreated: "2026-01-01T00:00:00.000Z",
        draftSource: "rules",
        aiConfident: null,
        aiMissing: null,
      },
    ]);
  });

  it("returns 502 when Mercado Libre fails", async () => {
    vi.mocked(listUnansweredQuestions).mockRejectedValue(new MlApiError(500, "boom"));
    const res = await GET();
    expect(res.status).toBe(502);
  });
});

describe("PATCH /api/questions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveCurrentAccount).mockResolvedValue(account);
  });

  it("returns 401 when there is no active account", async () => {
    vi.mocked(resolveCurrentAccount).mockResolvedValue(null);
    const request = { json: async () => ({ mlQuestionId: 55, answer: "hola", action: "save" }) } as any;
    const res = await PATCH(request);
    expect(res.status).toBe(401);
  });

  it("returns 400 when required fields are missing", async () => {
    const request = { json: async () => ({ mlQuestionId: 55 }) } as any;
    const res = await PATCH(request);
    expect(res.status).toBe(400);
  });

  it("saves a draft without calling Mercado Libre", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    vi.mocked(withScope).mockImplementation((ctx: any, fn: any) => fn({ query }));
    const request = { json: async () => ({ mlQuestionId: 55, answer: "Todavía escribiendo...", action: "save" }) } as any;

    const res = await PATCH(request);

    expect(await res.json()).toEqual({ ok: true });
    expect(answerQuestion).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledWith(expect.any(String), ["Todavía escribiendo...", "draft", "acc1", 55]);
  });

  it("sends the answer to Mercado Libre and marks the draft as sent", async () => {
    vi.mocked(answerQuestion).mockResolvedValue(undefined);
    const query = vi.fn().mockResolvedValue({ rows: [] });
    vi.mocked(withScope).mockImplementation((ctx: any, fn: any) => fn({ query }));
    const request = { json: async () => ({ mlQuestionId: 55, answer: "Sí, tenemos stock.", action: "send" }) } as any;

    const res = await PATCH(request);

    expect(await res.json()).toEqual({ ok: true });
    expect(answerQuestion).toHaveBeenCalledWith("acc1", 55, "Sí, tenemos stock.");
    expect(query).toHaveBeenCalledWith(expect.any(String), ["Sí, tenemos stock.", "sent", "acc1", 55]);
  });

  it("returns 502 and leaves the draft untouched when Mercado Libre rejects the answer", async () => {
    vi.mocked(answerQuestion).mockRejectedValue(new MlApiError(403, "write scope missing"));
    const query = vi.fn().mockResolvedValue({ rows: [] });
    vi.mocked(withScope).mockImplementation((ctx: any, fn: any) => fn({ query }));
    const request = { json: async () => ({ mlQuestionId: 55, answer: "Sí, tenemos stock.", action: "send" }) } as any;

    const res = await PATCH(request);

    expect(res.status).toBe(502);
    expect(query).not.toHaveBeenCalled();
  });
});
