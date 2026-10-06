import { NextRequest, NextResponse } from "next/server";
import { withScope } from "@/db/client";
import { insertTrialRequest, listTrialRequests, setTrialRequestStatus } from "@/db/trial-requests";
import { getCurrentUser } from "@/lib/current-account";
import { parseTrialRequest, TRIAL_STATUSES, type TrialStatus } from "@/lib/trial-request";

export const runtime = "nodejs";

/**
 * Formulario público de la landing: sin sesión a propósito (quien lo manda
 * todavía no tiene cuenta). RLS solo le deja insertar; leer y cambiar el
 * estado es cosa de un admin (GET y PATCH de abajo).
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const parsed = parseTrialRequest(body);
  // Al bot se le responde igual que a una persona: no aprende nada.
  if (parsed.ok === "bot") return NextResponse.json({ ok: true });
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  try {
    await withScope({}, (client) => insertTrialRequest(client, parsed.data));
  } catch (err) {
    console.error("Solicitud de prueba:", (err as Error).message);
    return NextResponse.json({ error: "No pudimos guardar tu solicitud. Probá de nuevo en un momento." }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user?.isAdmin) return NextResponse.json({ error: "No autorizado" }, { status: 403 });
  const requests = await withScope({ isAdmin: true, userEmail: user.email }, (client) => listTrialRequests(client));
  return NextResponse.json({ requests });
}

export async function PATCH(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user?.isAdmin) return NextResponse.json({ error: "No autorizado" }, { status: 403 });
  const { id, status } = (await request.json().catch(() => ({}))) as { id?: unknown; status?: unknown };
  if (typeof id !== "number" || !Number.isInteger(id) || !(TRIAL_STATUSES as readonly unknown[]).includes(status)) {
    return NextResponse.json({ error: "id y status válidos son requeridos" }, { status: 400 });
  }
  const updated = await withScope({ isAdmin: true, userEmail: user.email }, (client) =>
    setTrialRequestStatus(client, id, status as TrialStatus)
  );
  if (!updated) return NextResponse.json({ error: "No existe esa solicitud" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
