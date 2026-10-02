import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser, CURRENT_ACCOUNT_COOKIE } from "@/lib/current-account";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user?.isAdmin) return NextResponse.json({ error: "No autorizado" }, { status: 403 });

  const { accountId } = (await request.json().catch(() => ({}))) as { accountId?: string };
  if (!accountId) return NextResponse.json({ error: "accountId requerido" }, { status: 400 });

  const res = NextResponse.json({ ok: true });
  res.cookies.set(CURRENT_ACCOUNT_COOKIE, accountId, { httpOnly: true, sameSite: "lax", path: "/" });
  return res;
}
