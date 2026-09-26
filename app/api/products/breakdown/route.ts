import { NextRequest, NextResponse } from "next/server";
import { withScope } from "@/db/client";
import { hasColumn } from "@/db/schema-capabilities";
import { resolveCurrentAccount } from "@/lib/current-account";
import { revenueStatusFilter } from "@/lib/order-status";
import { appliesIva } from "@/db/accounts";
import { recalculateProduct } from "@/sync/sync-service";
import { getCurrentCostEntry } from "@/sync/profitability";

export const runtime = "nodejs";

export interface BreakdownSale {
  orderId: string;
  date: string;
  quantity: number;
  revenue: number;
  commission: number;
  shipping: number;
  ads: number;
  /** Costo de mercadería de la línea (costo unitario aplicado × cantidad). */
  cost: number | null;
  costPerUnit: number | null;
  taxes: number;
  iva: number;
  netProfit: number | null;
}

export interface ProductBreakdown {
  productId: string;
  unitsSold: number;
  /** Totales del período, para el "de dónde sale" el beneficio. */
  totals: { revenue: number; commission: number; shipping: number; ads: number; cost: number; taxes: number; iva: number; netProfit: number };
  /** Líneas cuyo costo aplicado no coincidía con el costo cargado y se
   * recalcularon en esta misma consulta. */
  healed: number;
  sales: BreakdownSale[];
}

interface SaleRow {
  id: string | number;
  orderid: string;
  datecreated: string | Date;
  quantity: number;
  unitprice: number;
  mlcommission: number;
  shippingcost: number;
  adscostallocated: number | null;
  costapplied: number | null;
  taxapplied: number | null;
  ivaapplied: number | null;
  netprofit: number | null;
}

/**
 * De qué está hecho el beneficio de UNA publicación: venta − comisión −
 * envío − publicidad − costo − impuestos − IVA, venta por venta.
 *
 * Además se autocorrige: si alguna venta tiene aplicado un costo que no es
 * el que corresponde según lo cargado hoy (quedó pisado por una
 * sincronización que corrió en paralelo con la carga del costo, o por
 * cualquier otro motivo), la recalcula en el momento. Así el beneficio nunca
 * puede quedar "congelado" con un costo viejo que el vendedor ya corrigió.
 */
export async function GET(request: NextRequest) {
  const account = await resolveCurrentAccount();
  if (!account) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const { searchParams } = request.nextUrl;
  const productId = searchParams.get("productId");
  if (!productId) return NextResponse.json({ error: "productId es requerido" }, { status: 400 });
  const from = searchParams.get("from") ?? "1970-01-01";
  const to = searchParams.get("to") ?? "9999-12-31";

  const breakdown = await withScope({ accountId: account.id }, async (client) => {
    const hasIva = await hasColumn(client, "order_items", "iva_applied");
    const ivaCol = hasIva ? "oi.iva_applied" : "NULL::double precision";

    const loadSales = async () =>
      (
        await client.query<SaleRow>(
          `SELECT oi.id, oi.order_id as orderId, o.date_created as dateCreated, oi.quantity,
                  oi.unit_price as unitPrice, oi.ml_commission as mlCommission, oi.shipping_cost as shippingCost,
                  oi.ads_cost_allocated as adsCostAllocated, oi.cost_applied as costApplied,
                  oi.tax_applied as taxApplied, ${ivaCol} as ivaApplied, oi.net_profit as netProfit
             FROM order_items oi JOIN orders o ON o.account_id = oi.account_id AND o.id = oi.order_id
            WHERE oi.account_id = $1 AND oi.product_id = $2
              AND o.date_created::date BETWEEN $3::date AND $4::date
              AND ${revenueStatusFilter()}
            ORDER BY o.date_created DESC`,
          [account.id, productId, from, to]
        )
      ).rows;

    const costs = (
      await client.query<{ cost: number; tax: number; validfrom: string | Date }>(
        `SELECT cost, tax, valid_from as validFrom FROM product_costs WHERE account_id = $1 AND product_id = $2 ORDER BY valid_from, id`,
        [account.id, productId]
      )
    ).rows.map((r) => ({ cost: Number(r.cost), tax: Number(r.tax), validFrom: new Date(r.validfrom).toISOString() }));

    let rows = await loadSales();
    const expected = getCurrentCostEntry(costs)?.cost ?? null;
    const stale = rows.filter((r) => {
      const applied = r.costapplied === null ? null : Number(r.costapplied);
      if (expected === null || applied === null) return expected !== applied;
      return Math.abs(expected - applied) > 0.005;
    }).length;
    if (stale > 0) {
      await recalculateProduct(client, account.id, productId, hasIva, account.otherTaxRate, appliesIva(account.taxCondition));
      rows = await loadSales();
    }

    const sales: BreakdownSale[] = rows.map((r) => {
      const quantity = Number(r.quantity);
      const costPerUnit = r.costapplied === null ? null : Number(r.costapplied);
      return {
        orderId: String(r.orderid),
        date: new Date(r.datecreated).toISOString(),
        quantity,
        revenue: Number(r.unitprice) * quantity,
        commission: Number(r.mlcommission ?? 0),
        shipping: Number(r.shippingcost ?? 0),
        ads: Number(r.adscostallocated ?? 0),
        cost: costPerUnit === null ? null : costPerUnit * quantity,
        costPerUnit,
        taxes: Number(r.taxapplied ?? 0) * quantity,
        iva: Number(r.ivaapplied ?? 0),
        netProfit: r.netprofit === null ? null : Number(r.netprofit),
      };
    });

    const sum = (pick: (s: BreakdownSale) => number | null) => sales.reduce((acc, s) => acc + (pick(s) ?? 0), 0);
    const result: ProductBreakdown = {
      productId,
      unitsSold: sum((s) => s.quantity),
      totals: {
        revenue: sum((s) => s.revenue),
        commission: sum((s) => s.commission),
        shipping: sum((s) => s.shipping),
        ads: sum((s) => s.ads),
        cost: sum((s) => s.cost),
        taxes: sum((s) => s.taxes),
        iva: sum((s) => s.iva),
        netProfit: sum((s) => s.netProfit),
      },
      healed: stale,
      sales,
    };
    return result;
  });

  return NextResponse.json(breakdown);
}
