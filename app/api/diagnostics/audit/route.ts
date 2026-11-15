import { NextRequest, NextResponse } from "next/server";
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
export async function GET(request: NextRequest) {
  const [account, user] = await Promise.all([resolveCurrentAccount(), getCurrentUser()]);
  if (!account) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  if (!user?.isAdmin) return NextResponse.json({ error: "Solo para administradores" }, { status: 403 });

  // ?probe=2026-11-01 → un solo pedido a ML (notas de crédito de ese período)
  // para ver si trae filas con el mismo detail_id y si las guardamos todas.
  const probeKey = request.nextUrl.searchParams.get("probe");
  if (probeKey) {
    const doc = request.nextUrl.searchParams.get("doc") === "BILL" ? "BILL" : "CREDIT_NOTE";
    return NextResponse.json(await probeCreditNotes(account.id, probeKey, doc));
  }

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

async function probeCreditNotes(accountId: string, key: string, doc: "BILL" | "CREDIT_NOTE") {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return { error: "probe=AAAA-MM-DD" };
  const token = await getValidAccessToken(accountId);
  const r = await tryFetch(`/billing/integration/periods/key/${key}/group/ML/details?document_type=${doc}&limit=1000&from_id=0`, token);
  if (!r.ok) return { error: r.error };
  const rows: any[] = r.body?.results ?? [];
  const ids: string[] = rows.map((x) => String(x?.charge_info?.detail_id ?? ""));
  const groups = new Map<string, any[]>();
  rows.forEach((x, i) => groups.set(ids[i], [...(groups.get(ids[i]) ?? []), x]));
  const amount = (x: any) => Number(x?.charge_info?.detail_amount ?? 0);
  const distinctLastWins = [...groups.values()].reduce((a, g) => a + amount(g[g.length - 1]), 0);
  const duplicated = [...groups.entries()].filter(([, g]) => g.length > 1);
  const numeric = ids.map(Number);
  const stored = await withScope({ accountId }, async (c) => {
    const q = await c.query<{ n: string; amount: string }>(
      `SELECT COUNT(*) as n, COALESCE(SUM(abs(amount)), 0) as amount FROM billing_charges WHERE account_id = $1 AND period_key = $2`,
      [accountId, `${key}#NC`]
    );
    return { filas: Number(q.rows[0].n), importe: Number(q.rows[0].amount) };
  });
  // ¿Dónde está cada fila que ML devolvió? Si están todas guardadas pero con
  // otra clave de período, no se perdió nada; si faltan, no se guardaron.
  const dbIds = ids.filter(Boolean);
  const where = await withScope({ accountId }, async (c) => {
    const found = await c.query<{ period_key: string; detail_type: string | null; n: string; amount: string }>(
      `SELECT period_key, detail_type, COUNT(*) as n, SUM(abs(amount)) as amount
         FROM billing_charges WHERE account_id = $1 AND detail_id = ANY($2::text[]) GROUP BY 1, 2 ORDER BY 3 DESC`,
      [accountId, dbIds]
    );
    return found.rows.map((x) => ({ periodoGuardado: x.period_key, tipo: x.detail_type, filas: Number(x.n), importe: Math.round(Number(x.amount) * 100) / 100 }));
  });
  const foundTotal = where.reduce((a, x) => a + x.filas, 0);
  return {
    periodo: key,
    documento: doc,
    dondeEstanLasFilas: { devueltasPorMl: dbIds.length, guardadasEnTotal: foundTotal, noGuardadas: dbIds.length - foundTotal, porPeriodoGuardado: where },
    mercadoLibre: {
      total: r.body?.total ?? null,
      filasDevueltas: rows.length,
      idsDistintos: groups.size,
      filasConIdRepetido: rows.length - groups.size,
      sinDetailId: ids.filter((i) => !i).length,
      sumaTodasLasFilas: Math.round(rows.reduce((a, x) => a + amount(x), 0) * 100) / 100,
      sumaConUnaFilaPorId: Math.round(distinctLastWins * 100) / 100,
      ordenadoPorId: numeric.every((v, i) => i === 0 || v >= numeric[i - 1]),
      lastId: r.body?.last_id ?? null,
      ejemplosDeIdRepetido: duplicated.slice(0, 4).map(([id, g]) => ({
        detailId: id,
        filas: g.length,
        importes: g.map(amount),
        ordenes: g.map((x) => x?.sales_info?.[0]?.order_id ?? null),
        tipos: g.map((x) => x?.charge_info?.detail_sub_type ?? null),
      })),
    },
    guardado: stored,
    comoLeerlo: "Si sumaTodasLasFilas es mayor que sumaConUnaFilaPorId (y se parece al importe del período), perdemos plata al guardar una sola fila por detail_id.",
  };
}
