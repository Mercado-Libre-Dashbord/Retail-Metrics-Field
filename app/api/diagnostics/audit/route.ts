import { NextResponse } from "next/server";
import { withScope } from "@/db/client";
import { hasColumn } from "@/db/schema-capabilities";
import { getCurrentUser, resolveCurrentAccount } from "@/lib/current-account";
import { getValidAccessToken } from "@/mcp/auth";
import { mlFetch } from "@/mcp/ml-client";
import { classifyCharge } from "@/sync/billing";
import { CHARGE_DATE_SQL, SIGNED_AMOUNT_SQL } from "@/sync/period-charges";

export const runtime = "nodejs";
export const maxDuration = 60;

async function tryFetch(path: string, token: string) {
  try {
    return { ok: true as const, body: await mlFetch(path, token) };
  } catch (e: any) {
    return { ok: false as const, error: String(e?.message ?? e).slice(0, 200) };
  }
}

/**
 * Solo admin. Dos controles para saber si el número final es exacto:
 *
 * 1. ¿Está completa la factura que guardamos? Por cada período, cuántos cargos
 *    y cuánta plata hay guardados contra lo que informa Mercado Libre (importe
 *    del período y cantidad de filas). Si faltan filas, hay ventas que siguen
 *    con la comisión y el envío estimados.
 * 2. ¿La publicidad que restamos (Mercado Ads) es la que ML cobra en la
 *    factura? Mes por mes, lo uno contra lo otro.
 *
 * Solo totales: ningún dato de compradores ni de ventas individuales.
 */
export async function GET() {
  const [account, user] = await Promise.all([resolveCurrentAccount(), getCurrentUser()]);
  if (!account) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  if (!user?.isAdmin) return NextResponse.json({ error: "Solo para administradores" }, { status: 403 });

  const stored = await withScope({ accountId: account.id }, async (client) => {
    if (!(await hasColumn(client, "billing_charges", "detail_id"))) return null;
    const byPeriod = await client.query<{ period_key: string; detail_type: string | null; n: string; amount: string; first: string; last: string }>(
      `SELECT period_key, detail_type, COUNT(*) as n, SUM(abs(amount)) as amount,
              to_char(MIN(${CHARGE_DATE_SQL}), 'YYYY-MM-DD') as first, to_char(MAX(${CHARGE_DATE_SQL}), 'YYYY-MM-DD') as last
         FROM billing_charges WHERE account_id = $1 AND detail_id ~ '^[0-9]+$'
        GROUP BY 1, 2 ORDER BY 1 DESC, 2 LIMIT 60`,
      [account.id]
    );
    const adsInvoice = await client.query<{ month: string; concept: string | null; detail_type: string | null; detail_sub_type: string | null; amount: string }>(
      `SELECT to_char(${CHARGE_DATE_SQL}, 'YYYY-MM') as month, concept, detail_type, detail_sub_type, SUM(${SIGNED_AMOUNT_SQL}) as amount
         FROM billing_charges
        WHERE account_id = $1 AND ${CHARGE_DATE_SQL} >= (now() - interval '5 months')
        GROUP BY 1, 2, 3, 4`,
      [account.id]
    );
    const adsApi = await client.query<{ month: string; amount: string }>(
      `SELECT to_char(date, 'YYYY-MM') as month, SUM(amount) as amount FROM ads_spend
        WHERE account_id = $1 AND channel = 'mercado_ads' AND date >= (now() - interval '5 months')
        GROUP BY 1`,
      [account.id]
    );
    const months = new Map<string, { month: string; mercadoAds: number; facturaProductAds: number; facturaOtraPublicidad: number; cociente: number | null }>();
    const get = (m: string) => months.get(m) ?? months.set(m, { month: m, mercadoAds: 0, facturaProductAds: 0, facturaOtraPublicidad: 0, cociente: null }).get(m)!;
    for (const r of adsApi.rows) get(r.month).mercadoAds += Number(r.amount);
    for (const r of adsInvoice.rows) {
      if (classifyCharge(r.concept, r.detail_type, r.detail_sub_type) !== "publicidad") continue;
      if (/products? ads/i.test(r.concept ?? "")) get(r.month).facturaProductAds += Number(r.amount);
      else get(r.month).facturaOtraPublicidad += Number(r.amount);
    }
    for (const m of months.values()) m.cociente = m.mercadoAds > 0 ? Math.round((m.facturaProductAds / m.mercadoAds) * 1000) / 1000 : null;
    return {
      guardado: byPeriod.rows.map((r) => ({ periodo: r.period_key, tipo: r.detail_type, filas: Number(r.n), importe: Number(r.amount), desde: r.first, hasta: r.last })),
      publicidadPorMes: [...months.values()].sort((a, b) => b.month.localeCompare(a.month)),
    };
  });
  if (!stored) return NextResponse.json({ error: "Falta la tabla billing_charges" });

  // Lo que informa Mercado Libre (4 pedidos: el recurso acepta 5 por minuto).
  const token = await getValidAccessToken(account.id);
  const periodsOf = (type: string) => `/billing/integration/monthly/periods?group=ML&document_type=${type}&offset=0&limit=4`;
  const [bills, notes] = await Promise.all([tryFetch(periodsOf("BILL"), token), tryFetch(periodsOf("CREDIT_NOTE"), token)]);
  const list = (r: Awaited<ReturnType<typeof tryFetch>>) =>
    r.ok ? (r.body?.results ?? []).map((p: any) => ({ periodo: p.key, desde: p.period?.date_from, hasta: p.period?.date_to, importe: p.amount, estado: p.period_status })) : r.error;
  // Cantidad de filas del último período cerrado, de cada documento.
  const closedKey = bills.ok ? (bills.body?.results ?? []).find((p: any) => p.period_status !== "OPEN")?.key : null;
  const rowsOf = async (type: string) => {
    if (!closedKey) return null;
    const r = await tryFetch(`/billing/integration/periods/key/${closedKey}/group/ML/details?document_type=${type}&limit=1`, token);
    return r.ok ? { periodo: closedKey, filas: r.body?.total ?? null } : r.error;
  };

  return NextResponse.json({
    ...stored,
    mercadoLibre: {
      facturas: list(bills),
      notasDeCredito: list(notes),
      filasFactura: await rowsOf("BILL"),
      filasNotasDeCredito: await rowsOf("CREDIT_NOTE"),
    },
    comoLeerlo: [
      "guardado vs mercadoLibre: para el mismo período, filas e importe tienen que ser parecidos. Las notas de crédito se guardan con el período terminado en #NC.",
      "publicidadPorMes.cociente: factura de Product Ads / Mercado Ads. Cerca de 1 = la app resta lo mismo que cobra ML. Cerca de 1,21 = Mercado Ads informa sin IVA y la factura lo cobra con IVA.",
    ],
  });
}
