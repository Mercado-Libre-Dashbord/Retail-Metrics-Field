import { NextRequest, NextResponse } from "next/server";
import { withScope } from "@/db/client";
import { resolveCurrentAccount } from "@/lib/current-account";
import { updateProductPriceStock } from "@/mcp/tools";
import { MlApiError } from "@/mcp/ml-client";

export const runtime = "nodejs";

// A diferencia de PATCH /api/products (que solo carga un costo nuestro,
// interno), esto escribe de verdad sobre la publicación en vivo del
// vendedor en Mercado Libre — requiere que la app tenga el scope "Write"
// habilitado, si no ML devuelve 403/401 acá.
export async function POST(request: NextRequest) {
  const account = await resolveCurrentAccount();
  if (!account) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const { productId, price, stock } = body as { productId?: string; price?: number; stock?: number };
  if (!productId || (price === undefined && stock === undefined)) {
    return NextResponse.json({ error: "productId y al menos uno de price/stock son requeridos" }, { status: 400 });
  }
  // Va directo a la URL de Mercado Libre: solo ids de publicación (MLA123…).
  if (typeof productId !== "string" || !/^[A-Z]{3}\d+$/.test(productId)) {
    return NextResponse.json({ error: "productId inválido" }, { status: 400 });
  }
  if (price !== undefined && (typeof price !== "number" || price <= 0)) {
    return NextResponse.json({ error: "price tiene que ser un número mayor a 0" }, { status: 400 });
  }
  if (stock !== undefined && (typeof stock !== "number" || stock < 0)) {
    return NextResponse.json({ error: "stock tiene que ser un número mayor o igual a 0" }, { status: 400 });
  }

  try {
    await updateProductPriceStock(account.id, productId, { price, stock });
  } catch (err) {
    if (err instanceof MlApiError) {
      return NextResponse.json({ error: `Mercado Libre rechazó el cambio: ${err.message}` }, { status: 502 });
    }
    throw err;
  }

  const updated = await withScope({ accountId: account.id }, async (client) => {
    const sets: string[] = [];
    const args: unknown[] = [];
    if (price !== undefined) {
      args.push(price);
      sets.push(`current_price = $${args.length}`);
    }
    if (stock !== undefined) {
      args.push(stock);
      sets.push(`stock = $${args.length}`);
    }
    args.push(account.id, productId);
    const result = await client.query(
      `UPDATE products SET ${sets.join(", ")} WHERE account_id = $${args.length - 1} AND id = $${args.length}
       RETURNING current_price as "currentPrice", stock`,
      args
    );
    return result.rows[0] ?? null;
  });

  return NextResponse.json({ ok: true, product: updated });
}
