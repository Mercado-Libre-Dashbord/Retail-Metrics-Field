import { NextRequest, NextResponse } from "next/server";
import { withScope } from "@/db/client";
import { resolveCurrentAccount } from "@/lib/current-account";
import { refreshCompetition } from "@/sync/competition";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Pide a Mercado Libre la competencia de las publicaciones con la foto más
 * vieja, hasta agotar el tiempo. Devuelve cuántas quedan: la pantalla vuelve
 * a llamar hasta que no quede ninguna. { productIds?, force? }
 */
export async function POST(request: NextRequest) {
  const account = await resolveCurrentAccount();
  if (!account) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as { productIds?: unknown; force?: unknown };
  const productIds = Array.isArray(body.productIds)
    ? body.productIds.filter((x): x is string => typeof x === "string" && /^[A-Z]{3}\d+$/.test(x)).slice(0, 200)
    : undefined;
  const result = await withScope({ accountId: account.id }, (client) =>
    refreshCompetition(client, account.id, { productIds, force: body.force === true, timeBudgetMs: 40_000 })
  );
  return NextResponse.json(result);
}
