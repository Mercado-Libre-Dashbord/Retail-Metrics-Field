import { NextRequest, NextResponse } from "next/server";
import { withScope } from "@/db/client";
import { hasColumn } from "@/db/schema-capabilities";
import { resolveCurrentAccount } from "@/lib/current-account";
import { revenueStatusFilter } from "@/lib/order-status";
import { recalculateProduct, healStaleCosts } from "@/sync/sync-service";
import { appliesIva } from "@/db/accounts";
import { computeProductMargin } from "@/lib/margin";

export const runtime = "nodejs";

/** Tiempo máximo que la carga de Productos dedica a corregir costos desfasados. */
const HEAL_TIME_BUDGET_MS = 8_000;

export async function GET(request: NextRequest) {
  const account = await resolveCurrentAccount();
  if (!account) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const { searchParams } = request.nextUrl;
  const from = searchParams.get("from") ?? "1970-01-01";
  const to = searchParams.get("to") ?? "9999-12-31";

  const withMargin = await withScope({ accountId: account.id }, async (client) => {
    // Si todavía no se corrió la migración correspondiente, se devuelve null
    // (o se omite la columna) en vez de romper toda la página (ver
    // db/schema-capabilities.ts).
    const thumbnailColumn = (await hasColumn(client, "products", "thumbnail")) ? "p.thumbnail" : "NULL::text";
    const hasFull = await hasColumn(client, "products", "full_stock_qty");
    const fullCols = hasFull
      ? `p.logistic_type as "logisticType", p.full_stock_qty as "fullStockQty", p.full_stock_unavailable_qty as "fullStockUnavailableQty",`
      : `NULL::text as "logisticType", NULL::integer as "fullStockQty", NULL::integer as "fullStockUnavailableQty",`;
    const hasLowStock = await hasColumn(client, "products", "low_stock_threshold");
    const lowStockCol = hasLowStock ? `p.low_stock_threshold as "lowStockThreshold"` : `NULL::integer as "lowStockThreshold"`;
    // TC guardado junto con el último costo cargado (ver migración 019): deja
    // mostrar ese mismo costo también en dólares, con el TC de cuando se
    // cargó (no el de hoy, que lo haría "saltar" solo con que cambie la
    // cotización).
    const hasCostFx = await hasColumn(client, "product_costs", "exchange_rate");
    const costFxCol = hasCostFx
      ? `(SELECT exchange_rate FROM product_costs pc WHERE pc.account_id = p.account_id AND pc.product_id = p.id ORDER BY pc.valid_from DESC, pc.id DESC LIMIT 1) as "currentCostExchangeRate",`
      : `NULL::double precision as "currentCostExchangeRate",`;
    // Antes de leer el beneficio, se corrigen las ventas que hayan quedado
    // con un costo distinto del vigente (ver healStaleCosts). Si falla, se muestra lo que hay: nunca debe
    // tirar abajo la pantalla entera.
    try {
      await client.query("SAVEPOINT heal_costs");
      const hasIva = await hasColumn(client, "order_items", "iva_applied");
      // Con tope de tiempo: la pantalla no puede quedar esperando. Lo que no
      // entre se corrige en la próxima carga o en el próximo Sincronizar
      // (el recálculo del sync aplica el costo vigente a todas las ventas).
      await healStaleCosts(client, account.id, hasIva, account.otherTaxRate, appliesIva(account.taxCondition), 50, Date.now() + HEAL_TIME_BUDGET_MS);
      await client.query("RELEASE SAVEPOINT heal_costs");
    } catch (err) {
      console.warn("No se pudieron recalcular costos editados recientemente:", (err as Error).message);
      await client.query("ROLLBACK TO SAVEPOINT heal_costs").catch(() => {});
    }

    const hasIvaCol = await hasColumn(client, "order_items", "iva_applied");
    const hasEstimates = await hasColumn(client, "products", "est_updated_at");
    const estimateCols = hasEstimates
      ? `p.est_price as "estPrice", p.est_sale_fee as "estSaleFee", p.est_fixed_fee as "estFixedFee",
         p.est_shipping_cost as "estShippingCost", p.listing_type_id as "listingTypeId", p.free_shipping as "freeShipping",`
      : `NULL::double precision as "estPrice", NULL::double precision as "estSaleFee", NULL::double precision as "estFixedFee",
         NULL::double precision as "estShippingCost", NULL::text as "listingTypeId", NULL::boolean as "freeShipping",`;
    // Las ventas del período se agregan UNA vez por producto (CTE) en vez de
    // con una subconsulta por columna y por producto: además de vendidas y
    // beneficio, el margen real necesita el desglose completo (comisión,
    // envío, publicidad, costo, impuestos, IVA).
    const result = await client.query(
      `WITH sales AS (
         SELECT oi.product_id,
                SUM(oi.quantity) as units,
                SUM(oi.unit_price * oi.quantity) as revenue,
                SUM(oi.ml_commission) as commission,
                SUM(oi.shipping_cost) as shipping,
                SUM(oi.ads_cost_allocated) as ads,
                SUM(oi.cost_applied * oi.quantity) as cost,
                SUM(COALESCE(oi.tax_applied, 0) * oi.quantity) as taxes,
                ${hasIvaCol ? "SUM(COALESCE(oi.iva_applied, 0))" : "0"} as iva,
                SUM(oi.net_profit) as net,
                COUNT(*) FILTER (WHERE oi.net_profit IS NULL) as "linesWithoutCost"
           FROM order_items oi JOIN orders o ON o.account_id = oi.account_id AND o.id = oi.order_id
          WHERE oi.account_id = $3 AND o.date_created::date BETWEEN $1::date AND $2::date
            AND ${revenueStatusFilter()}
          GROUP BY oi.product_id
       ),
       last_sale AS (
         -- Última venta de siempre, sin acotar por from/to: es una señal de
         -- "hace cuánto que no se mueve" independiente del período elegido.
         SELECT oi.product_id, MAX(o.date_created) as last_sale
           FROM order_items oi JOIN orders o ON o.account_id = oi.account_id AND o.id = oi.order_id
          WHERE oi.account_id = $3 AND ${revenueStatusFilter()}
          GROUP BY oi.product_id
       )
       SELECT p.id, p.title, p.sku, p.current_price as "currentPrice", p.stock,
              ${thumbnailColumn} as thumbnail,
              ${fullCols}
              ${lowStockCol},
              ${costFxCol}
              ${estimateCols}
              (SELECT cost FROM product_costs pc WHERE pc.account_id = p.account_id AND pc.product_id = p.id ORDER BY pc.valid_from DESC, pc.id DESC LIMIT 1) as "currentCost",
              COALESCE(s.units, 0) as "unitsSold",
              COALESCE(s.net, 0) as "totalProfit",
              s.revenue, s.commission, s.shipping, s.ads, s.cost as "soldCost", s.taxes, s.iva, s.net,
              COALESCE(s."linesWithoutCost", 0) as "linesWithoutCost",
              ls.last_sale as "lastSaleDate"
         FROM products p
         LEFT JOIN sales s ON s.product_id = p.id
         LEFT JOIN last_sale ls ON ls.product_id = p.id
        WHERE p.account_id = $3
        ORDER BY p.title`,
      [from, to, account.id]
    );

    const rows = result.rows as {
      id: string;
      title: string;
      sku: string | null;
      currentPrice: number;
      stock: number;
      thumbnail: string | null;
      logisticType: string | null;
      fullStockQty: number | null;
      fullStockUnavailableQty: number | null;
      lowStockThreshold: number | null;
      currentCost: number | null;
      currentCostExchangeRate: number | null;
      unitsSold: number | string;
      totalProfit: number | string;
      lastSaleDate: string | Date | null;
      estPrice: number | null;
      estSaleFee: number | null;
      estFixedFee: number | null;
      estShippingCost: number | null;
      listingTypeId: string | null;
      freeShipping: boolean | null;
      revenue: number | string | null;
      commission: number | string | null;
      shipping: number | string | null;
      ads: number | string | null;
      soldCost: number | string | null;
      taxes: number | string | null;
      iva: number | string | null;
      net: number | string | null;
      linesWithoutCost: number | string;
    }[];

    const ivaApplies = appliesIva(account.taxCondition);
    return rows.map((raw) => {
      // Postgres devuelve SUM de enteros y COUNT como texto (bigint).
      const num = (v: number | string | null) => (v === null ? 0 : Number(v));
      const { revenue, commission, shipping, ads, soldCost, taxes, iva, net, linesWithoutCost, ...rest } = raw;
      const r = {
        ...rest,
        currentPrice: Number(raw.currentPrice),
        currentCost: raw.currentCost === null ? null : Number(raw.currentCost),
        unitsSold: num(raw.unitsSold),
        totalProfit: num(raw.totalProfit),
      };
      const inFull = r.logisticType === "fulfillment";
      // El stock "de verdad" de un producto en Full es el que tiene guardado
      // ahí, no el `stock` de la publicación (que ML también expone, pero no
      // es lo que hay físicamente disponible para vender). Se manda ya
      // calculado (no cada consumidor del lado del cliente) para que el
      // panel de alertas, el resaltado de la fila y el número mostrado nunca
      // puedan quedar en desacuerdo entre sí.
      const effectiveStock = inFull && r.fullStockQty !== null ? r.fullStockQty : r.stock;
      // El valor de "capital inmovilizado" suma TODO lo guardado físicamente
      // (disponible + no disponible: dañado, en revisión, en tránsito) — esa
      // plata sigue inmovilizada aunque no se pueda vender ahora mismo. El
      // stock "efectivo" de arriba, en cambio, se queda solo con lo
      // disponible a propósito: para la alerta de stock bajo importa lo que
      // se puede vender, no lo que hay guardado sin poder despacharse.
      const fullStockValue =
        inFull && r.fullStockQty !== null && r.currentCost !== null
          ? (r.fullStockQty + (r.fullStockUnavailableQty ?? 0)) * r.currentCost
          : null;
      // Ganancia neta real, por unidad, de las ventas que de verdad pasaron —
      // ya con la comisión, el envío y los impuestos que se cobraron en cada
      // caso (no una estimación con la comisión/envío de hoy). Es una señal
      // más dura que el margen de arriba: dice si el producto YA te está
      // dejando pérdida en la práctica, no si en teoría podría.
      const avgProfitPerUnit = r.unitsSold > 0 ? r.totalProfit / r.unitsSold : null;
      // El mismo costo, mostrado en dólares con el TC de cuando se cargó. Sin
      // ese TC guardado (costos cargados antes de la migración 019, o nunca
      // cargados) no hay con qué convertir.
      const currentCostUsd =
        r.currentCost !== null && r.currentCostExchangeRate !== null && r.currentCostExchangeRate > 0
          ? r.currentCost / r.currentCostExchangeRate
          : null;
      // Margen con los mismos descuentos que la ganancia de cada venta (ver
      // lib/margin.ts): real si vendió en el período, estimado con los cargos
      // de ML de hoy si no. Antes era solo (precio − costo) / precio, y un
      // producto con envío gratis y comisión alta mostraba 70% mientras cada
      // venta dejaba pérdida.
      const margin = computeProductMargin({
        currentPrice: r.currentPrice,
        currentCost: r.currentCost,
        otherTaxRate: account.otherTaxRate,
        appliesIva: ivaApplies,
        realized: r.unitsSold > 0
          ? {
              units: r.unitsSold, revenue: num(revenue), commission: num(commission), shipping: num(shipping),
              ads: num(ads), cost: num(soldCost), taxes: num(taxes), iva: num(iva), net: num(net),
              linesWithoutCost: num(linesWithoutCost),
            }
          : null,
        estimate: raw.estSaleFee !== null
          ? {
              price: raw.estPrice === null ? null : Number(raw.estPrice),
              saleFee: Number(raw.estSaleFee),
              fixedFee: raw.estFixedFee === null ? null : Number(raw.estFixedFee),
              shippingCost: raw.estShippingCost === null ? null : Number(raw.estShippingCost),
            }
          : null,
      });
      return {
        ...r,
        effectiveStock,
        fullStockValue,
        currentCostUsd,
        lastSaleDate: r.lastSaleDate ? new Date(r.lastSaleDate).toISOString() : null,
        margin,
        marginPct: margin?.pct ?? null,
        lowStock: r.lowStockThreshold !== null && effectiveStock <= r.lowStockThreshold,
        avgProfitPerUnit,
        negativeMargin: avgProfitPerUnit !== null && avgProfitPerUnit < 0,
      };
    });
  });

  return NextResponse.json(withMargin);
}

export async function PATCH(request: NextRequest) {
  const account = await resolveCurrentAccount();
  if (!account) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const body = await request.json();
  const { productId, cost, exchangeRate, costCurrency, lowStockThreshold } = body as {
    productId: string;
    cost?: number;
    /** TC vigente al momento de cargar el costo — para poder mostrarlo
     * también en dólares más adelante (ver migración 019). Opcional: sin él
     * el lado en dólares queda vacío hasta que se vuelva a guardar. */
    exchangeRate?: number | null;
    /** En qué moneda lo escribió el vendedor. Solo informativo: `cost` sigue
     * siempre en pesos, ya convertido si hacía falta. */
    costCurrency?: "ARS" | "USD";
    lowStockThreshold?: number | null;
  };
  if (!productId) {
    return NextResponse.json({ error: "productId es requerido" }, { status: 400 });
  }
  const hasCost = cost !== undefined;
  const hasThreshold = lowStockThreshold !== undefined;
  if (!hasCost && !hasThreshold) {
    return NextResponse.json({ error: "Mandá cost o lowStockThreshold." }, { status: 400 });
  }
  if (hasCost && (typeof cost !== "number" || cost < 0)) {
    return NextResponse.json({ error: "cost tiene que ser un número >= 0." }, { status: 400 });
  }
  if (hasCost && exchangeRate !== undefined && exchangeRate !== null && (typeof exchangeRate !== "number" || exchangeRate <= 0)) {
    return NextResponse.json({ error: "exchangeRate tiene que ser un número > 0, o no mandarlo." }, { status: 400 });
  }
  if (hasThreshold && lowStockThreshold !== null && (typeof lowStockThreshold !== "number" || lowStockThreshold < 0 || !Number.isInteger(lowStockThreshold))) {
    return NextResponse.json({ error: "lowStockThreshold tiene que ser un entero >= 0, o null para sacar la alerta." }, { status: 400 });
  }

  const result = await withScope({ accountId: account.id }, async (client) => {
    // El costo y el umbral son dos cosas independientes: si falta la
    // migración del umbral, no tiene por qué frenar el guardado del costo
    // (que no depende de ella) cuando alguien manda los dos juntos.
    let thresholdError: string | null = null;
    if (hasThreshold) {
      if (await hasColumn(client, "products", "low_stock_threshold")) {
        await client.query(`UPDATE products SET low_stock_threshold = $1 WHERE account_id = $2 AND id = $3`, [
          lowStockThreshold, account.id, productId,
        ]);
      } else {
        thresholdError = "Falta correr la migración db/postgres/migrations/014-alerta-stock-bajo.sql.";
      }
    }

    if (!hasCost) return { itemsUpdated: 0, thresholdError };

    // Los impuestos ya no se guardan por producto: son una alícuota de la
    // cuenta (ver /api/account/settings). La columna `tax` queda en 0.
    if (await hasColumn(client, "product_costs", "exchange_rate")) {
      await client.query(
        `INSERT INTO product_costs (account_id, product_id, cost, valid_from, exchange_rate, cost_currency) VALUES ($1, $2, $3, $4, $5, $6)`,
        [account.id, productId, cost, new Date().toISOString(), exchangeRate ?? null, costCurrency ?? "ARS"]
      );
    } else {
      await client.query(
        `INSERT INTO product_costs (account_id, product_id, cost, valid_from) VALUES ($1, $2, $3, $4)`,
        [account.id, productId, cost, new Date().toISOString()]
      );
    }

    // Y se aplica ya mismo a las ventas de ese producto. Antes el costo se
    // guardaba y nada más: había que correr un "Sincronizar" completo —que
    // recorre todo el historial contra la API de ML— para que el número del
    // panel cambiara. Mientras tanto el vendedor veía "N líneas sin costo
    // cargado" para productos que acababa de completar, y parecía que la
    // carga no había tomado.
    const hasIva = await hasColumn(client, "order_items", "iva_applied");
    const itemsUpdated = await recalculateProduct(client, account.id, productId, hasIva, account.otherTaxRate, appliesIva(account.taxCondition));
    return { itemsUpdated, thresholdError };
  });

  // Pedido solo del umbral y sin la migración: no hay nada más que reportar,
  // es un error de verdad.
  if (result.thresholdError && !hasCost) {
    return NextResponse.json({ error: result.thresholdError }, { status: 503 });
  }
  return NextResponse.json({
    ok: true,
    itemsUpdated: result.itemsUpdated,
    ...(result.thresholdError ? { warning: result.thresholdError } : {}),
  });
}

/**
 * Borra TODO el historial de costos de un producto y deja sus ventas sin
 * costo (fuera de la ganancia neta) hasta que se cargue uno nuevo. Ya no hace
 * falta para corregir un costo mal cargado —cargar el correcto encima
 * recalcula todo el historial (ver getCurrentCostEntry)—, pero sigue siendo
 * la forma de decir "este producto no tiene costo".
 */
export async function DELETE(request: NextRequest) {
  const account = await resolveCurrentAccount();
  if (!account) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const productId = request.nextUrl.searchParams.get("productId");
  if (!productId) {
    return NextResponse.json({ error: "productId es requerido" }, { status: 400 });
  }

  const itemsUpdated = await withScope({ accountId: account.id }, async (client) => {
    await client.query(`DELETE FROM product_costs WHERE account_id = $1 AND product_id = $2`, [account.id, productId]);
    const hasIva = await hasColumn(client, "order_items", "iva_applied");
    return recalculateProduct(client, account.id, productId, hasIva, account.otherTaxRate, appliesIva(account.taxCondition));
  });

  return NextResponse.json({ ok: true, itemsUpdated });
}
