import { NextRequest, NextResponse } from "next/server";
import { withScope } from "@/db/client";
import { resolveCurrentAccount } from "@/lib/current-account";
import { loadCompetitionData } from "@/lib/competition-data";

export const runtime = "nodejs";

/**
 * La competencia de cada publicación de catálogo: la última foto (quién gana,
 * por qué, si conviene igualar) y los cambios de precio de los demás.
 * ?target=0.2 margen objetivo · ?days=7 ventana del historial de cambios
 */
export async function GET(request: NextRequest) {
  const account = await resolveCurrentAccount();
  if (!account) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  const sp = request.nextUrl.searchParams;
  const target = Math.min(0.6, Math.max(0, Number(sp.get("target") ?? 0.2) || 0));
  const days = Math.min(90, Math.max(1, Math.round(Number(sp.get("days") ?? 7) || 7)));

  const data = await withScope({ accountId: account.id }, (client) => loadCompetitionData(client, account.id, target, days));
  if (!data.available) return NextResponse.json({ available: false, rows: [], changes: [], counts: {} });
  const { lastUpdated, counts, rows, changes } = data;
  return NextResponse.json({ available: true, target, days, lastUpdated, counts, rows, changes });
}
