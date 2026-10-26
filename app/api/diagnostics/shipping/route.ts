import { NextRequest, NextResponse } from "next/server";
import { withScope } from "@/db/client";
import { resolveCurrentAccount } from "@/lib/current-account";
import { diagnoseOrderShipping } from "@/mcp/tools";

export const runtime = "nodejs";

/**
 * Para una orden puntual: lo que responde Mercado Libre sobre su envío (quién
 * lo pagó, sin datos personales) y lo que la app tiene guardado. Solo lectura
 * y solo de la cuenta con la que se entró: no expone nada de otras cuentas.
 */
export async function GET(request: NextRequest) {
  const account = await resolveCurrentAccount();
  if (!account) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const orderId = request.nextUrl.searchParams.get("orderId")?.trim();
  if (!orderId || !/^\d+$/.test(orderId)) {
    return NextResponse.json({ error: "Pasá ?orderId= con el número de orden de Mercado Libre." }, { status: 400 });
  }

  const stored = await withScope({ accountId: account.id }, async (client) => {
    const r = await client.query(
      `SELECT product_id as "productId", quantity, unit_price as "unitPrice", shipping_cost as "shippingCost", net_profit as "netProfit"
         FROM order_items WHERE account_id = $1 AND order_id = $2`,
      [account.id, orderId]
    );
    return r.rows;
  });

  try {
    return NextResponse.json({ ...(await diagnoseOrderShipping(account.id, orderId)), stored });
  } catch (err) {
    return NextResponse.json({ error: `Mercado Libre no devolvió la orden: ${(err as Error).message}`, stored }, { status: 502 });
  }
}
