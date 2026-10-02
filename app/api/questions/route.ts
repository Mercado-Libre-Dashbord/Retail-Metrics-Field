import { NextRequest, NextResponse } from "next/server";
import { withScope } from "@/db/client";
import { hasColumn } from "@/db/schema-capabilities";
import { resolveCurrentAccount } from "@/lib/current-account";
import { listUnansweredQuestions, answerQuestion } from "@/mcp/tools";
import { MlApiError } from "@/mcp/ml-client";
import { draftAnswer } from "@/mcp/question-drafts";

export const runtime = "nodejs";

interface QuestionRow {
  mlquestionid: string;
  productid: string;
  producttitle: string;
  questiontext: string;
  draftanswer: string;
  datecreated: string | Date;
}

export async function GET() {
  const account = await resolveCurrentAccount();
  if (!account) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  if (!account.mlSellerId) {
    return NextResponse.json(
      { error: "Esta cuenta todavía no conectó Mercado Libre. Andá a /api/ml/login para autorizar." },
      { status: 400 }
    );
  }

  try {
    const fresh = await listUnansweredQuestions(account.id, account.mlSellerId);

    const rows = await withScope({ accountId: account.id }, async (client) => {
      for (const q of fresh) {
        const productResult = await client.query<{ current_price: number; stock: number }>(
          `SELECT current_price, stock FROM products WHERE account_id = $1 AND id = $2`,
          [account.id, q.productId]
        );
        const product = productResult.rows[0];
        const suggested = product ? draftAnswer(q.text, { price: Number(product.current_price ?? 0), stock: Number(product.stock ?? 0) }) : "";

        // ON CONFLICT DO NOTHING: si el vendedor ya venía editando el borrador
        // de esta pregunta, no lo pisamos con la sugerencia recién generada.
        await client.query(
          `INSERT INTO question_drafts (account_id, ml_question_id, product_id, question_text, draft_answer, status, date_created)
           VALUES ($1, $2, $3, $4, $5, 'draft', $6)
           ON CONFLICT (account_id, ml_question_id) DO NOTHING`,
          [account.id, q.id, q.productId, q.text, suggested, q.dateCreated]
        );
      }

      const thumbnailColumn = (await hasColumn(client, "products", "thumbnail")) ? "p.thumbnail" : "NULL::text";
      const result = await client.query<QuestionRow>(
        `SELECT qd.ml_question_id as mlQuestionId, qd.product_id as productId, p.title as productTitle,
                ${thumbnailColumn} as thumbnail,
                qd.question_text as questionText, qd.draft_answer as draftAnswer, qd.date_created as dateCreated
         FROM question_drafts qd
         LEFT JOIN products p ON p.account_id = qd.account_id AND p.id = qd.product_id
         WHERE qd.account_id = $1 AND qd.status = 'draft'
         ORDER BY qd.date_created DESC`,
        [account.id]
      );
      return result.rows;
    });

    return NextResponse.json(
      rows.map((r: any) => ({
        mlQuestionId: r.mlquestionid,
        productId: r.productid,
        productTitle: r.producttitle ?? "(producto no sincronizado)",
        thumbnail: r.thumbnail ?? null,
        questionText: r.questiontext,
        draftAnswer: r.draftanswer,
        dateCreated: new Date(r.datecreated).toISOString(),
      }))
    );
  } catch (err) {
    if (err instanceof MlApiError) {
      return NextResponse.json({ error: err.message }, { status: 502 });
    }
    throw err;
  }
}

export async function PATCH(request: NextRequest) {
  const account = await resolveCurrentAccount();
  if (!account) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const { mlQuestionId, answer, action } = body as { mlQuestionId?: number; answer?: string; action?: "save" | "send" };
  if (!mlQuestionId || typeof answer !== "string" || (action !== "save" && action !== "send")) {
    return NextResponse.json({ error: "mlQuestionId, answer y action ('save'|'send') son requeridos" }, { status: 400 });
  }

  if (action === "send") {
    try {
      await answerQuestion(account.id, mlQuestionId, answer);
    } catch (err) {
      if (err instanceof MlApiError) {
        return NextResponse.json({ error: `No se pudo enviar la respuesta a Mercado Libre: ${err.message}` }, { status: 502 });
      }
      throw err;
    }
  }

  await withScope({ accountId: account.id }, (client) =>
    client.query(
      `UPDATE question_drafts SET draft_answer = $1, status = $2, answered_at = CASE WHEN $2 = 'sent' THEN now() ELSE answered_at END
       WHERE account_id = $3 AND ml_question_id = $4`,
      [answer, action === "send" ? "sent" : "draft", account.id, mlQuestionId]
    )
  );

  return NextResponse.json({ ok: true });
}
