import { NextRequest, NextResponse } from "next/server";
import { withScope } from "@/db/client";
import { hasColumn } from "@/db/schema-capabilities";
import { getCurrentUser, resolveCurrentAccount } from "@/lib/current-account";
import { diagnoseOrderShipping } from "@/mcp/tools";
import { classifyCharge } from "@/sync/billing";

export const runtime = "nodejs";

/**
 * "¿Este envío existe de verdad?" para una orden puntual: lo que responde
 * Mercado Libre sobre el envío (sin datos personales), lo que la app tiene
 * guardado, y lo que ML efectivamente facturó de envío para esa orden. Solo
 * admin, igual que /api/diagnostics.
 */
export async function GET(request: NextRequest) {
  const [account, user] = await Promise.all([resolveCurrentAccount(), getCurrentUser()]);
  if (!account) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  if (!user?.isAdmin) return NextResponse.json({ error: "Solo para administradores" }, { status: 403 });

  const orderId = request.nextUrl.searchParams.get("orderId")?.trim();
  if (!orderId || !/^\d+$/.test(orderId)) {
    return NextResponse.json({ error: "Pasá ?orderId= con el número de orden de Mercado Libre." }, { status: 400 });
  }

  const stored = await withScope({ accountId: account.id }, async (client) => {
    const items = await client.query<{ productId: string; quantity: number; shippingCost: number; netProfit: number | null }>(
      `SELECT product_id as "productId", quantity, shipping_cost as "shippingCost", net_profit as "netProfit"
         FROM order_items WHERE account_id = $1 AND order_id = $2`,
      [account.id, orderId]
    );
    let billedShipping: number | null = null;
    if (await hasColumn(client, "billing_charges", "detail_id")) {
      const charges = await client.query<{ concept: string | null; detailType: string | null; detailSubType: string | null; amount: number }>(
        `SELECT concept, detail_type as "detailType", detail_sub_type as "detailSubType", amount
           FROM billing_charges WHERE account_id = $1 AND order_id = $2`,
        [account.id, orderId]
      );
      billedShipping = charges.rows
        .filter((c) => classifyCharge(c.concept, c.detailType, c.detailSubType) === "envio")
        .reduce((sum, c) => sum + Math.abs(Number(c.amount)), 0);
    }
    return { items: items.rows, billedShipping };
  });

  try {
    const ml = await diagnoseOrderShipping(account.id, orderId);
    return NextResponse.json({ ...ml, stored: stored.items, billedShippingForThisOrder: stored.billedShipping });
  } catch (err) {
    return NextResponse.json(
      { error: `Mercado Libre no devolvió la orden: ${(err as Error).message}`, stored: stored.items, billedShippingForThisOrder: stored.billedShipping },
      { status: 502 }
    );
  }
}
