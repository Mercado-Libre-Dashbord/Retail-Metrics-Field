import { NextRequest, NextResponse } from "next/server";
import { resolveCurrentAccount } from "@/lib/current-account";
import { listCampaigns, setCampaignStatus } from "@/mcp/tools";
import { MlApiError } from "@/mcp/ml-client";

export const runtime = "nodejs";

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
    const campaigns = await listCampaigns(account.id);
    return NextResponse.json(campaigns);
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
  const { campaignId, status } = body as { campaignId?: string; status?: "active" | "paused" };
  if (!campaignId || (status !== "active" && status !== "paused")) {
    return NextResponse.json({ error: "campaignId y status ('active'|'paused') son requeridos" }, { status: 400 });
  }
  // Va directo a la URL de Mercado Ads: solo ids numéricos.
  if (!/^\d+$/.test(String(campaignId))) {
    return NextResponse.json({ error: "campaignId inválido" }, { status: 400 });
  }

  try {
    await setCampaignStatus(account.id, campaignId, status);
  } catch (err) {
    if (err instanceof MlApiError) {
      return NextResponse.json({ error: `Mercado Libre rechazó el cambio: ${err.message}` }, { status: 502 });
    }
    throw err;
  }

  return NextResponse.json({ ok: true });
}
