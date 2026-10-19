import { NextRequest, NextResponse } from "next/server";
import { withScope } from "@/db/client";
import { hasColumn } from "@/db/schema-capabilities";
import { resolveCurrentAccount } from "@/lib/current-account";
import { BUCKET_LABEL, type ChargeBucket } from "@/sync/billing";
import { chargeDetails, TREATMENT_LABEL, type ChargeTreatment } from "@/sync/period-charges";

export const runtime = "nodejs";

/**
 * Lo que Mercado Libre efectivamente facturó en el período, agrupado por
 * concepto, con el detalle de cada cargo y qué hace la ganancia neta con él
 * (ya restado venta por venta, se resta aparte, o no se resta). Es el número
 * "de verdad" contra el que conciliar lo que la app calcula.
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
      return { available: false, buckets: [], total: 0, subtracted: 0 };
    }

    const details = await chargeDetails(client, account.id, from, to);
    const byBucket = new Map<ChargeBucket, { amount: number; byTreatment: Partial<Record<ChargeTreatment, number>>; details: typeof details }>();
    for (const d of details) {
      const b = byBucket.get(d.bucket) ?? { amount: 0, byTreatment: {}, details: [] };
      b.amount += d.amount;
      b.byTreatment[d.treatment] = (b.byTreatment[d.treatment] ?? 0) + d.amount;
      b.details.push(d);
      byBucket.set(d.bucket, b);
    }

    const buckets = [...byBucket.entries()]
      .map(([bucket, b]) => ({
        bucket,
        label: BUCKET_LABEL[bucket],
        amount: b.amount,
        subtracted: b.byTreatment.subtracted ?? 0,
        treatments: Object.entries(b.byTreatment).map(([t, amount]) => ({
          treatment: t as ChargeTreatment,
          label: TREATMENT_LABEL[t as ChargeTreatment],
          amount,
        })),
        details: b.details.map((d) => ({
          concept: d.concept,
          linkedToOrder: d.linkedToOrder,
          manual: d.manual,
          treatment: d.treatment,
          treatmentLabel: TREATMENT_LABEL[d.treatment],
          count: d.count,
          amount: d.amount,
        })),
      }))
      .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));

    return {
      available: true,
      buckets,
      total: buckets.reduce((sum, b) => sum + b.amount, 0),
      subtracted: buckets.reduce((sum, b) => sum + b.subtracted, 0),
      charges: details.reduce((n, d) => n + d.count, 0),
    };
  });

  return NextResponse.json(data);
}
