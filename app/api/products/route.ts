import { NextRequest, NextResponse } from "next/server";
import { withScope } from "@/db/client";
import { hasColumn } from "@/db/schema-capabilities";
import { resolveCurrentAccount } from "@/lib/current-account";
import { revenueStatusFilter } from "@/lib/order-status";
import { recalculateProduct } from "@/sync/sync-service";
import { appliesIva } from "@/db/accounts";

export const runtime = "nodejs";

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
      ? `(SELECT exchange_rate FROM product_costs pc WHERE pc.account_id = p.account_id AND pc.product_id = p.id ORDER BY pc.valid_from DESC LIMIT 1) as "currentCostExchangeRate",`
      : `NULL::double precision as "currentCostExchangeRate",`;
    const result = await client.query(
      `SELECT p.id, p.title, p.sku, p.current_price as "currentPrice", p.stock,
              ${thumbnailColumn} as thumbnail,
              ${fullCols}
              ${lowStockCol},
              ${costFxCol}
              (SELECT cost FROM product_costs pc WHERE pc.account_id = p.account_id AND pc.product_id = p.id ORDER BY pc.valid_from DESC LIMIT 1) as "currentCost",
              (SELECT COALESCE(SUM(oi.quantity), 0) FROM order_items oi JOIN orders o ON o.account_id = oi.account_id AND o.id = oi.order_id
                WHERE oi.account_id = p.account_id AND oi.product_id = p.id AND o.date_created::date BETWEEN $1::date AND $2::date
                  AND ${revenueStatusFilter()}) as "unitsSold",
              (SELECT COALESCE(SUM(oi.net_profit), 0) FROM order_items oi JOIN orders o ON o.account_id = oi.account_id AND o.id = oi.order_id
                WHERE oi.account_id = p.account_id AND oi.product_id = p.id AND o.date_created::date BETWEEN $1::date AND $2::date
                  AND ${revenueStatusFilter()}) as "totalProfit",
              -- Última venta de siempre, sin acotar por from/to: es una señal
              -- de "hace cuánto que no se mueve" independiente del período
              -- elegido arriba, para poder ordenar el catálogo por eso.
              (SELECT MAX(o.date_created) FROM order_items oi JOIN orders o ON o.account_id = oi.account_id AND o.id = oi.order_id
                WHERE oi.account_id = p.account_id AND oi.product_id = p.id AND ${revenueStatusFilter()}) as "lastSaleDate"
         FROM products p WHERE p.account_id = $3 ORDER BY p.title`,
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
      unitsSold: number;
      totalProfit: number;
      lastSaleDate: string | Date | null;
    }[];

    // El margen descuenta la alícuota de otros impuestos de la CUENTA. Antes
    // salía de un impuesto cargado producto por producto, que ya no existe:
    // seguir leyéndolo mostraría márgenes calculados con datos viejos.
    return rows.map((r) => {
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
      return {
        ...r,
        effectiveStock,
        fullStockValue,
        currentCostUsd,
        lastSaleDate: r.lastSaleDate ? new Date(r.lastSaleDate).toISOString() : null,
        marginPct:
          r.currentCost !== null && r.currentPrice > 0
            ? (r.currentPrice * (1 - account.otherTaxRate) - r.currentCost) / r.currentPrice
            : null,
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
 * Borra TODO el historial de costos de un producto (no solo el último). Un
 * costo cargado mal y corregido después seguía afectando la ganancia de las
 * ventas viejas: sin ningún costo con fecha anterior a la venta,
 * getCostEntryAtDate usa el PRIMER costo cargado como mejor estimación —
 * que quedaba siendo el erróneo, no el corregido, aunque se hubiera cargado
 * uno nuevo encima. Borrando el historial entero, el próximo costo que se
 * cargue vuelve a ser "el primero" y se aplica bien a todo el historial.
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
