import { NextRequest, NextResponse } from "next/server";
import { withScope } from "@/db/client";
import { hasColumn } from "@/db/schema-capabilities";
import { resolveCurrentAccount } from "@/lib/current-account";
import { aiAnswersEnabled } from "@/lib/answer-ai";

export const runtime = "nodejs";

const MAX_LENGTH = 4000;

/** Información general del vendedor que la IA usa para responder consultas. */
export async function GET() {
  const account = await resolveCurrentAccount();
  if (!account) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  const result = await withScope({ accountId: account.id }, async (client) => {
    if (!(await hasColumn(client, "answer_settings", "seller_info"))) return null;
    const r = await client.query<{ seller_info: string }>(`SELECT seller_info FROM answer_settings WHERE account_id = $1`, [account.id]);
    return r.rows[0]?.seller_info ?? "";
  });
  return NextResponse.json({ sellerInfo: result ?? "", available: result !== null, aiEnabled: aiAnswersEnabled() });
}

export async function PUT(request: NextRequest) {
  const account = await resolveCurrentAccount();
  if (!account) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  const body = await request.json().catch(() => ({}));
  const sellerInfo = (body as { sellerInfo?: unknown }).sellerInfo;
  if (typeof sellerInfo !== "string") return NextResponse.json({ error: "Falta el texto." }, { status: 400 });
  if (sellerInfo.length > MAX_LENGTH) {
    return NextResponse.json({ error: `Como mucho ${MAX_LENGTH.toLocaleString("es-AR")} caracteres.` }, { status: 400 });
  }
  const saved = await withScope({ accountId: account.id }, async (client) => {
    if (!(await hasColumn(client, "answer_settings", "seller_info"))) return false;
    await client.query(
      `INSERT INTO answer_settings (account_id, seller_info, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (account_id) DO UPDATE SET seller_info = EXCLUDED.seller_info, updated_at = now()`,
      [account.id, sellerInfo.trim()]
    );
    return true;
  });
  if (!saved) {
    return NextResponse.json({ error: "Falta correr la migración db/postgres/migrations/024-respuestas-con-ia.sql." }, { status: 503 });
  }
  return NextResponse.json({ ok: true });
}
