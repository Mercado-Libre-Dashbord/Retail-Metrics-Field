import { NextRequest, NextResponse } from "next/server";
import { withScope } from "@/db/client";
import { hasColumn } from "@/db/schema-capabilities";
import { getCurrentUser, resolveCurrentAccount } from "@/lib/current-account";
import { revenueStatusFilter } from "@/lib/order-status";
import { getValidAccessToken } from "@/mcp/auth";
import { mlFetch } from "@/mcp/ml-client";
import { classifyCharge } from "@/sync/billing";
import { CHARGE_DATE_SQL } from "@/sync/period-charges";

export const runtime = "nodejs";
export const maxDuration = 60;

interface OrderRow {
  id: string;
  date: string;
  revenue: number;
  commission: number;
  shipping: number;
}

/**
 * Conciliación orden por orden (solo admin): lo que la app calculó de comisión
 * y envío contra lo que Mercado Libre facturó atado a esa misma orden. Sirve
 * para saber, con números y no a ojo, si una diferencia viene de nuestro
 * cálculo o de cómo se clasifican los cargos de la factura.
 */
export async function GET(request: NextRequest) {
  const [account, user] = await Promise.all([resolveCurrentAccount(), getCurrentUser()]);
  if (!account) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  if (!user?.isAdmin) return NextResponse.json({ error: "Solo para administradores" }, { status: 403 });

  const sp = request.nextUrl.searchParams;
  const from = sp.get("from") ?? new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const to = sp.get("to") ?? new Date().toISOString().slice(0, 10);

  const data = await withScope({ accountId: account.id }, async (client) => {
    if (!(await hasColumn(client, "billing_charges", "detail_id"))) return { error: "Falta la tabla billing_charges" };

    const orders = (
      await client.query<OrderRow>(
        `SELECT o.id, to_char(o.date_created, 'YYYY-MM-DD') as date,
                SUM(oi.unit_price * oi.quantity) as revenue, SUM(oi.ml_commission) as commission, SUM(oi.shipping_cost) as shipping
           FROM orders o JOIN order_items oi ON oi.account_id = o.account_id AND oi.order_id = o.id
          WHERE o.account_id = $1 AND o.date_created::date BETWEEN $2::date AND $3::date AND ${revenueStatusFilter()}
          GROUP BY o.id, o.date_created`,
        [account.id, from, to]
      )
    ).rows.map((r) => ({ ...r, revenue: Number(r.revenue), commission: Number(r.commission), shipping: Number(r.shipping) }));
    const orderIds = new Set(orders.map((o) => o.id));

    // Todos los cargos del período, y además los atados a estas órdenes
    // aunque se hayan facturado en otro mes.
    const charges = (
      await client.query<{ order_id: string | null; concept: string | null; detail_type: string | null; detail_sub_type: string | null; amount: number; n: number }>(
        `SELECT order_id, concept, detail_type, detail_sub_type, SUM(amount) as amount, COUNT(*) as n
           FROM billing_charges
          WHERE account_id = $1 AND (${CHARGE_DATE_SQL} BETWEEN $2::date AND $3::date OR order_id = ANY($4::text[]))
          GROUP BY 1, 2, 3, 4`,
        [account.id, from, to, [...orderIds]]
      )
    ).rows;

    const billed = new Map<string, { commission: number; shipping: number; other: number }>();
    const concepts = new Map<string, { bucket: string; withOrder: number; withoutOrder: number; ordersInRange: number; amount: number }>();
    let chargesWithOrderNotInDb = 0;
    for (const c of charges) {
      const bucket = classifyCharge(c.concept, c.detail_type, c.detail_sub_type);
      const key = `${c.concept ?? "—"} | ${c.detail_type ?? "—"} | ${c.detail_sub_type ?? "—"}`;
      const k = concepts.get(key) ?? { bucket, withOrder: 0, withoutOrder: 0, ordersInRange: 0, amount: 0 };
      k.amount += Number(c.amount);
      if (c.order_id) k.withOrder += Number(c.n); else k.withoutOrder += Number(c.n);
      if (c.order_id && orderIds.has(c.order_id)) {
        k.ordersInRange += Number(c.n);
        const b = billed.get(c.order_id) ?? { commission: 0, shipping: 0, other: 0 };
        if (bucket === "comision") b.commission += Number(c.amount);
        else if (bucket === "envio") b.shipping += Number(c.amount);
        else b.other += Number(c.amount);
        billed.set(c.order_id, b);
      } else if (c.order_id) chargesWithOrderNotInDb += Number(c.n);
      concepts.set(key, k);
    }

    const withBilling = orders.filter((o) => billed.has(o.id));
    const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
    const diffs = withBilling
      .map((o) => ({ order: o.id, date: o.date, revenue: o.revenue, ourShipping: o.shipping, billedShipping: billed.get(o.id)!.shipping, ourCommission: o.commission, billedCommission: billed.get(o.id)!.commission }))
      .sort((a, b) => Math.abs(b.ourShipping - b.billedShipping) - Math.abs(a.ourShipping - a.billedShipping));
    const ratios = new Map<string, number>();
    for (const d of diffs) {
      if (d.billedShipping <= 0 || d.ourShipping <= 0) {
        const k = d.ourShipping > 0 ? "facturado 0, nosotros > 0" : d.billedShipping > 0 ? "nosotros 0, facturado > 0" : "ambos 0";
        ratios.set(k, (ratios.get(k) ?? 0) + 1);
      } else {
        const k = `nuestro/facturado ≈ ${(Math.round((d.ourShipping / d.billedShipping) * 10) / 10).toFixed(1)}`;
        ratios.set(k, (ratios.get(k) ?? 0) + 1);
      }
    }

    // Tres órdenes con más diferencia: la respuesta cruda de costos de envío
    // (solo montos y claves, sin datos del comprador) para ver de dónde sale.
    const samples: unknown[] = [];
    try {
      const token = await getValidAccessToken(account.id);
      for (const d of diffs.slice(0, 3)) {
        const order = await mlFetch(`/orders/${d.order}`, token);
        const shipmentId = order?.shipping?.id;
        if (!shipmentId) { samples.push({ order: d.order, shipmentId: null, packId: order?.pack_id ?? null }); continue; }
        const costs = await mlFetch(`/shipments/${shipmentId}/costs`, token, { headers: { "x-format-new": "true" } });
        samples.push({
          order: d.order,
          packId: order?.pack_id ?? null,
          shipmentId,
          ourShipping: d.ourShipping,
          billedShipping: d.billedShipping,
          costsKeys: Object.keys(costs ?? {}),
          grossAmount: costs?.gross_amount ?? null,
          receiverCost: costs?.receiver?.cost ?? null,
          senders: Array.isArray(costs?.senders)
            ? costs.senders.map((s: any) => ({ cost: s?.cost, compensation: s?.compensation, save: s?.save, discounts: s?.discounts, charges: s?.charges }))
            : null,
          senderOld: costs?.sender ? { cost: costs.sender.cost } : null,
        });
      }
    } catch (err) {
      samples.push({ error: (err as Error).message });
    }

    return {
      period: { from, to },
      orders: orders.length,
      ordersWithBillingCharges: withBilling.length,
      chargesWithOrderNotInDb,
      totals: {
        ourShippingAllOrders: sum(orders.map((o) => o.shipping)),
        ourShippingOrdersWithBilling: sum(withBilling.map((o) => o.shipping)),
        billedShippingOrdersWithBilling: sum(withBilling.map((o) => billed.get(o.id)!.shipping)),
        ourCommissionOrdersWithBilling: sum(withBilling.map((o) => o.commission)),
        billedCommissionOrdersWithBilling: sum(withBilling.map((o) => billed.get(o.id)!.commission)),
      },
      shippingRatioDistribution: Object.fromEntries([...ratios.entries()].sort((a, b) => b[1] - a[1])),
      topShippingDiffs: diffs.slice(0, 15),
      concepts: [...concepts.entries()].map(([k, v]) => ({ concept: k, ...v })).sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)),
      samples,
    };
  });

  return NextResponse.json(data);
}
