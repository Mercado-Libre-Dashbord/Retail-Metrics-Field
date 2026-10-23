import { NextRequest, NextResponse } from "next/server";
import { withScope } from "@/db/client";
import { hasColumn } from "@/db/schema-capabilities";
import { resolveCurrentAccount } from "@/lib/current-account";
import { getItemKnowledge, type ItemKnowledge } from "@/mcp/tools";
import { aiAnswersEnabled, aiDraftAnswer, AiDraftError, type AiDraft } from "@/lib/answer-ai";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Consultas por pedido: con más, el pedido se pasa del tiempo de la función. */
const MAX_PER_REQUEST = 8;
const CONCURRENCY = 4;

interface PendingRow {
  ml_question_id: string;
  product_id: string;
  question_text: string;
}

export type DraftResult =
  | ({ mlQuestionId: string; ok: true } & AiDraft)
  | { mlQuestionId: string; ok: false; error: string };

/**
 * Escribe con IA el borrador de las consultas pedidas (o de las pendientes
 * que todavía no pasaron por la IA ni editó el vendedor). No manda nada a
 * Mercado Libre: deja el borrador guardado para revisar.
 */
export async function POST(request: NextRequest) {
  const account = await resolveCurrentAccount();
  if (!account) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  if (!aiAnswersEnabled()) {
    return NextResponse.json({ error: "Las respuestas con IA no están activadas (falta ANTHROPIC_API_KEY)." }, { status: 503 });
  }

  const body = await request.json().catch(() => ({}));
  const ids = Array.isArray((body as { mlQuestionIds?: unknown }).mlQuestionIds)
    ? ((body as { mlQuestionIds: unknown[] }).mlQuestionIds.map(Number).filter((n) => Number.isSafeInteger(n) && n > 0))
    : null;

  const pending = await withScope({ accountId: account.id }, async (client) => {
    if (!(await hasColumn(client, "question_drafts", "draft_source"))) return null;
    const settings = await client.query<{ seller_info: string }>(`SELECT seller_info FROM answer_settings WHERE account_id = $1`, [account.id]);
    const rows = ids
      ? await client.query<PendingRow>(
          `SELECT ml_question_id::text, product_id, question_text FROM question_drafts
           WHERE account_id = $1 AND status = 'draft' AND ml_question_id = ANY($2::bigint[])
           ORDER BY date_created DESC LIMIT $3`,
          [account.id, ids, MAX_PER_REQUEST]
        )
      : await client.query<PendingRow>(
          `SELECT ml_question_id::text, product_id, question_text FROM question_drafts
           WHERE account_id = $1 AND status = 'draft' AND draft_source = 'rules'
           ORDER BY date_created DESC LIMIT $2`,
          [account.id, MAX_PER_REQUEST]
        );
    return { sellerInfo: settings.rows[0]?.seller_info ?? "", rows: rows.rows };
  });
  if (!pending) {
    return NextResponse.json({ error: "Falta correr la migración db/postgres/migrations/024-respuestas-con-ia.sql." }, { status: 503 });
  }

  // Varias consultas de la misma publicación comparten la ficha: se pide una vez.
  const knowledge = new Map<string, Promise<ItemKnowledge>>();
  const itemFor = (id: string) => {
    if (!knowledge.has(id)) knowledge.set(id, getItemKnowledge(account.id, id));
    return knowledge.get(id)!;
  };

  const results: DraftResult[] = [];
  const queue = [...pending.rows];
  async function worker() {
    for (let row = queue.shift(); row; row = queue.shift()) {
      try {
        const draft = await aiDraftAnswer({ question: row.question_text, item: await itemFor(row.product_id), sellerInfo: pending!.sellerInfo });
        results.push({ mlQuestionId: row.ml_question_id, ok: true, ...draft });
      } catch (err) {
        console.error("[questions/draft]", row.ml_question_id, err);
        const error = err instanceof AiDraftError ? err.message : "No se pudo escribir el borrador. Probá de nuevo en un rato.";
        results.push({ mlQuestionId: row.ml_question_id, ok: false, error });
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const ok = results.filter((r): r is Extract<DraftResult, { ok: true }> => r.ok);
  if (ok.length) {
    await withScope({ accountId: account.id }, async (client) => {
      for (const r of ok) {
        // status = 'draft': si mientras tanto la mandaron, no se toca.
        await client.query(
          `UPDATE question_drafts SET draft_answer = $1, draft_source = 'ai', ai_confident = $2, ai_missing = $3
           WHERE account_id = $4 AND ml_question_id = $5 AND status = 'draft'`,
          [r.answer, r.confident, r.missing || null, account.id, r.mlQuestionId]
        );
      }
    });
  }

  // Sin ids, puede haber más pendientes: quien llama vuelve a pedir.
  return NextResponse.json({ results, more: !ids && pending.rows.length === MAX_PER_REQUEST });
}
