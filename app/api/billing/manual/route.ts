import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { withScope } from "@/db/client";
import { hasColumn } from "@/db/schema-capabilities";
import { resolveCurrentAccount } from "@/lib/current-account";
import { BUCKET_LABEL, MANUAL_DETAIL_TYPE, classifyCharge, isChargeBucket, manualSubType } from "@/sync/billing";

export const runtime = "nodejs";

const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const MAX_DESCRIPTION = 200;

interface ManualRow {
  id: string;
  date: string;
  concept: string | null;
  detailSubType: string | null;
  amount: number;
}

/**
 * Cargos de facturación de ML cargados a mano por el vendedor: los que no
 * llegan por la API de facturación (ver MANUAL_DETAIL_TYPE en
 * sync/billing.ts). Se suman en /api/billing junto con los sincronizados.
 */
export async function GET(request: NextRequest) {
  const account = await resolveCurrentAccount();
  if (!account) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const { searchParams } = request.nextUrl;
  const from = searchParams.get("from") ?? "1970-01-01";
  const to = searchParams.get("to") ?? "9999-12-31";

  const rows = await withScope({ accountId: account.id }, async (client) => {
    if (!(await hasColumn(client, "billing_charges", "detail_id"))) return [];
    const result = await client.query<ManualRow>(
      `SELECT detail_id as id, to_char(charged_at, 'YYYY-MM-DD') as date, concept,
              detail_sub_type as "detailSubType", amount
       FROM billing_charges
       WHERE account_id = $1 AND detail_type = $2 AND charged_at::date BETWEEN $3::date AND $4::date
       ORDER BY charged_at DESC, detail_id`,
      [account.id, MANUAL_DETAIL_TYPE, from, to]
    );
    return result.rows;
  });

  return NextResponse.json(
    rows.map((r) => {
      const bucket = classifyCharge(r.detailSubType);
      return { id: r.id, date: r.date, bucket, label: BUCKET_LABEL[bucket], description: r.concept, amount: Number(r.amount) };
    })
  );
}

export async function POST(request: NextRequest) {
  const account = await resolveCurrentAccount();
  if (!account) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as {
    date?: unknown;
    bucket?: unknown;
    amount?: unknown;
    description?: unknown;
  };
  const { date, bucket, amount } = body;

  if (typeof date !== "string" || !DATE_RE.test(date)) {
    return NextResponse.json({ error: "Elegí una fecha válida." }, { status: 400 });
  }
  if (!isChargeBucket(bucket)) {
    return NextResponse.json({ error: "Elegí un concepto." }, { status: 400 });
  }
  // Negativo vale: una nota de crédito de ML resta del total facturado.
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 1e12) {
    return NextResponse.json({ error: "Ingresá un importe distinto de 0." }, { status: 400 });
  }
  const description =
    typeof body.description === "string" && body.description.trim() !== ""
      ? body.description.trim().slice(0, MAX_DESCRIPTION)
      : null;

  const id = `manual-${randomUUID()}`;
  const saved = await withScope({ accountId: account.id }, async (client) => {
    if (!(await hasColumn(client, "billing_charges", "detail_id"))) return false;
    await client.query(
      `INSERT INTO billing_charges
         (account_id, detail_id, period_key, detail_type, detail_sub_type, concept, order_id, amount, charged_at)
       VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $8::date)`,
      [account.id, id, date.slice(0, 7), MANUAL_DETAIL_TYPE, manualSubType(bucket), description, amount, date]
    );
    return true;
  });
  if (!saved) {
    return NextResponse.json({ error: "Falta correr la migración db/postgres/migrations/002-iva-y-facturacion.sql." }, { status: 503 });
  }
  return NextResponse.json({ ok: true, id });
}

/** Borra un cargo manual. Los cargos sincronizados desde ML no se pueden borrar desde acá. */
export async function DELETE(request: NextRequest) {
  const account = await resolveCurrentAccount();
  if (!account) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const id = request.nextUrl.searchParams.get("id");
  if (!id || !id.startsWith("manual-")) {
    return NextResponse.json({ error: "Cargo inválido." }, { status: 400 });
  }

  const deleted = await withScope({ accountId: account.id }, async (client) => {
    const result = await client.query(
      `DELETE FROM billing_charges WHERE account_id = $1 AND detail_id = $2 AND detail_type = $3`,
      [account.id, id, MANUAL_DETAIL_TYPE]
    );
    return (result.rowCount ?? 0) > 0;
  });
  if (!deleted) return NextResponse.json({ error: "No se encontró el cargo." }, { status: 404 });
  return NextResponse.json({ ok: true });
}
