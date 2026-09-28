import { NextRequest, NextResponse } from "next/server";
import { withScope } from "@/db/client";
import { hasColumn } from "@/db/schema-capabilities";
import { resolveCurrentAccount } from "@/lib/current-account";
import { classifyCharge, BUCKET_LABEL, type ChargeBucket } from "@/sync/billing";

export const runtime = "nodejs";

interface ChargeRow {
  concept: string | null;
  detailType: string | null;
  detailSubType: string | null;
  amount: number;
}

/**
 * Lo que Mercado Libre efectivamente facturó en el período, agrupado por
 * concepto. Es el número "de verdad" contra el que conciliar lo que la app
 * estima orden por orden.
 */
export async function GET(request: NextRequest) {
  const account = await resolveCurrentAccount();
  if (!account) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const { searchParams } = request.nextUrl;
  const from = searchParams.get("from") ?? "1970-01-01";
  const to = searchParams.get("to") ?? "9999-12-31";

  const data = await withScope({ accountId: account.id }, async (client) => {
    // La tabla llega por migración manual; sin ella se devuelve vacío en vez
    // de romper la página (ver db/schema-capabilities.ts).
    if (!(await hasColumn(client, "billing_charges", "detail_id"))) {
      return { available: false, buckets: [], total: 0 };
    }

    const result = await client.query<ChargeRow>(
      `SELECT concept, detail_type as "detailType", detail_sub_type as "detailSubType", amount
       FROM billing_charges
       WHERE account_id = $1 AND (charged_at IS NULL OR charged_at::date BETWEEN $2::date AND $3::date)`,
      [account.id, from, to]
    );

    const totals = new Map<ChargeBucket, number>();
    for (const row of result.rows) {
      const bucket = classifyCharge(row.concept, row.detailType, row.detailSubType);
      totals.set(bucket, (totals.get(bucket) ?? 0) + Number(row.amount));
    }

    const buckets = [...totals.entries()]
      .map(([bucket, amount]) => ({ bucket, label: BUCKET_LABEL[bucket], amount }))
      .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));

    return {
      available: true,
      buckets,
      total: buckets.reduce((sum, b) => sum + b.amount, 0),
      charges: result.rows.length,
    };
  });

  return NextResponse.json(data);
}
