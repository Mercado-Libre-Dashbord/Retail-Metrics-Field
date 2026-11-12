import { NextResponse } from "next/server";
import { getCurrentUser, resolveCurrentAccount } from "@/lib/current-account";
import { getValidAccessToken } from "@/mcp/auth";
import { mlFetch } from "@/mcp/ml-client";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Solo la forma de la respuesta y los códigos de cargo: nunca datos de compradores. */
function shape(value: unknown, depth = 0): unknown {
  if (Array.isArray(value)) return { array: value.length, first: value.length ? shape(value[0], depth + 1) : null };
  if (value && typeof value === "object") {
    if (depth > 3) return "{…}";
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, shape(v, depth + 1)]));
  }
  return typeof value === "number" ? value : typeof value === "string" ? value.slice(0, 40) : value;
}

async function probe(label: string, path: string, token: string) {
  try {
    const body = await mlFetch(path, token);
    const rows: any[] = body?.results ?? body?.periods ?? body?.documents ?? [];
    return {
      label,
      path,
      ok: true,
      count: Array.isArray(rows) ? rows.length : null,
      shape: shape(body),
      // Códigos y montos de los primeros cargos, para ver si hay notas de
      // crédito de Envíos Flex y con qué concepto vienen.
      sample: Array.isArray(rows)
        ? rows.slice(0, 5).map((r) => ({
            key: r?.key ?? null,
            type: r?.charge_info?.detail_type ?? r?.document_type ?? null,
            subType: r?.charge_info?.detail_sub_type ?? null,
            concept: r?.charge_info?.transaction_detail ?? r?.period?.date_from ?? null,
            amount: r?.charge_info?.detail_amount ?? r?.amount ?? null,
          }))
        : null,
    };
  } catch (e: any) {
    return { label, path, ok: false, status: e?.status ?? null, error: String(e?.message ?? e).slice(0, 300) };
  }
}

/**
 * Solo admin. Prueba de dónde se pueden traer, sin cargarlas a mano, las
 * notas de crédito (por ejemplo las bonificaciones de Envíos Flex, que ML
 * paga directo a Mercado Pago) y los comprobantes de cada factura. Ninguna de
 * estas rutas está confirmada en la documentación: este diagnóstico dice cuál
 * responde con la cuenta real antes de programar nada encima.
 */
export async function GET() {
  const [account, user] = await Promise.all([resolveCurrentAccount(), getCurrentUser()]);
  if (!account) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  if (!user?.isAdmin) return NextResponse.json({ error: "Solo para administradores" }, { status: 403 });

  const token = await getValidAccessToken(account.id);
  const periodsOf = (group: string, type: string) =>
    `/billing/integration/monthly/periods?group=${group}&document_type=${type}&offset=0&limit=3`;

  const periods = await Promise.all([
    probe("Períodos ML · facturas", periodsOf("ML", "BILL"), token),
    probe("Períodos ML · notas de crédito", periodsOf("ML", "CREDIT_NOTE"), token),
    probe("Períodos MP · facturas", periodsOf("MP", "BILL"), token),
    probe("Períodos MP · notas de crédito", periodsOf("MP", "CREDIT_NOTE"), token),
  ]);

  // Con el período de notas de crédito más reciente que exista, se pide su detalle.
  const details: unknown[] = [];
  for (const [group, label] of [["ML", "ML"], ["MP", "MP"]] as const) {
    const first = periods.find((p) => p.label === `Períodos ${label} · notas de crédito`);
    const s0 = first && first.ok ? (first.sample as any[] | null)?.[0] : null;
    const key = String(s0?.key ?? s0?.concept ?? "").slice(0, 10);
    if (key) {
      details.push(await probe(`Detalle ${label} · notas de crédito ${key}`, `/billing/integration/periods/key/${key}/group/${group}/details?document_type=CREDIT_NOTE&limit=5`, token));
      details.push(await probe(`Comprobantes ${label} ${key}`, `/billing/integration/periods/key/${key}/documents?group=${group}&document_type=CREDIT_NOTE&limit=5`, token));
    }
  }

  return NextResponse.json({ periods, details });
}
