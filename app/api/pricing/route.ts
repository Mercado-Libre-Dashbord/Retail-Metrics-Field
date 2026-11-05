import { NextRequest, NextResponse } from "next/server";
import { withScope } from "@/db/client";
import { resolveCurrentAccount } from "@/lib/current-account";
import { loadPricingRows } from "@/lib/pricing-data";

export const runtime = "nodejs";

/**
 * Piso y precio sugerido de cada publicación, con las tasas reales de sus
 * ventas recientes (ver lib/pricing.ts).
 *
 * ?target=0.2  margen objetivo (0 a 0,6)
 * ?days=90     período de referencia para las tasas
 * ?ads=0       no contar la publicidad
 */
export async function GET(request: NextRequest) {
  const account = await resolveCurrentAccount();
  if (!account) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const sp = request.nextUrl.searchParams;
  const target = Math.min(0.6, Math.max(0, Number(sp.get("target") ?? 0.2) || 0));
  const days = Math.min(365, Math.max(7, Math.round(Number(sp.get("days") ?? 90) || 90)));
  const includeAds = sp.get("ads") !== "0";

  const rows = await withScope({ accountId: account.id }, (client) => loadPricingRows(client, account.id, { target, days, includeAds }));

  const counts = rows.reduce<Record<string, number>>((acc, r) => ((acc[r.status] = (acc[r.status] ?? 0) + 1), acc), {});
  return NextResponse.json({ target, days, includeAds, counts, rows });
}
