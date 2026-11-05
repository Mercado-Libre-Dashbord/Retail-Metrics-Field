import { NextRequest, NextResponse } from "next/server";
import { resolveCurrentAccount } from "@/lib/current-account";
import { getPriceToWin } from "@/mcp/tools";

export const runtime = "nodejs";

/** "Precio para ganar" de una publicación de catálogo (ver getPriceToWin). */
export async function GET(request: NextRequest) {
  const account = await resolveCurrentAccount();
  if (!account) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  const id = request.nextUrl.searchParams.get("productId") ?? "";
  if (!/^[A-Z]{3}\d+$/.test(id)) return NextResponse.json({ error: "productId inválido" }, { status: 400 });
  return NextResponse.json(await getPriceToWin(account.id, id));
}
