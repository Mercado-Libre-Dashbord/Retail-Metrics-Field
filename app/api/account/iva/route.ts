import { NextRequest, NextResponse } from "next/server";
import { withScope } from "@/db/client";
import { appliesIva } from "@/db/accounts";
import { resolveCurrentAccount } from "@/lib/current-account";
import { IVA_RATE } from "@/lib/iva";
import { applyIvaPayments, ivaPaymentsAvailable, listIvaMonths, saveIvaPayment } from "@/sync/iva-payments";

export const runtime = "nodejs";

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
/** El saldo de IVA de un mes nunca supera el débito: 21/121 ≈ 17,4% de lo
 * facturado. Más que eso es un error de tipeo o de mes. */
const MAX_EFFECTIVE_RATE = IVA_RATE / (1 + IVA_RATE);

/** IVA pagado por mes: lo que cargó el vendedor, la facturación del mes y
 * el % efectivo que resulta. Solo para Responsable Inscripto. */
export async function GET() {
  const account = await resolveCurrentAccount();
  if (!account) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  const data = await withScope({ accountId: account.id }, async (client) => ({
    available: await ivaPaymentsAvailable(client),
    months: await listIvaMonths(client, account.id),
  }));
  return NextResponse.json({ ...data, appliesIva: appliesIva(account.taxCondition) });
}

/** Guarda (o borra, con amount null) el IVA pagado de un mes y recalcula el
 * IVA y la ganancia de todas las ventas en el momento. */
export async function PUT(request: NextRequest) {
  const account = await resolveCurrentAccount();
  if (!account) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  if (!appliesIva(account.taxCondition)) {
    return NextResponse.json({ error: "El IVA solo se calcula para Responsables Inscriptos." }, { status: 400 });
  }

  const { period, amount } = (await request.json().catch(() => ({}))) as { period?: unknown; amount?: unknown };
  if (typeof period !== "string" || !PERIOD_RE.test(period)) {
    return NextResponse.json({ error: "Mes inválido." }, { status: 400 });
  }
  if (amount !== null && (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0 || amount > 1e12)) {
    return NextResponse.json({ error: "Ingresá un monto en pesos, 0 o mayor." }, { status: 400 });
  }

  const result = await withScope({ accountId: account.id }, async (client) => {
    if (!(await ivaPaymentsAvailable(client))) return null;
    if (amount !== null) {
      const month = (await listIvaMonths(client, account.id, 600)).find((m) => m.period === period);
      if (!month || month.revenue <= 0) return { error: "No hay ventas sincronizadas en ese mes." };
      if ((amount as number) / month.revenue > MAX_EFFECTIVE_RATE + 1e-9) {
        const max = Math.floor(month.revenue * MAX_EFFECTIVE_RATE).toLocaleString("es-AR");
        return { error: `Es más IVA del que pueden generar tus ventas de ese mes (como máximo $${max}). Revisá el monto o el mes.` };
      }
    }
    await saveIvaPayment(client, account.id, period, amount as number | null);
    const updated = await applyIvaPayments(client, account.id, { force: true });
    return { updated, months: await listIvaMonths(client, account.id) };
  });
  if (!result) {
    return NextResponse.json({ error: "Falta correr la migración db/postgres/migrations/022-iva-pagado.sql." }, { status: 503 });
  }
  if ("error" in result) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json({ ok: true, ...result });
}
