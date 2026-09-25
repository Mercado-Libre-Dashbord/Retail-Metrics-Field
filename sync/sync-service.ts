import type { QueryExecutor } from "@/db/client";
import { listProducts, listOrders, getOrderDetail, getAdsSpend, listBillingPeriods, getBillingCharges, getProductsByIds, getOrderItemTitles, getFullStock, scanProductIds, getProductDetails, type MlProduct } from "@/mcp/tools";
import { getCostEntryAtDate, allocateAdsCost, calculateNetProfit, calculateIva } from "./profitability";
import { hasColumn } from "@/db/schema-capabilities";

/**
 * Se sube cuando cambia algo de cómo se procesa una orden (por ejemplo, de
 * dónde sale el costo de envío). Las órdenes guardadas con una versión menor
 * se vuelven a pedir a la API en el próximo sync; las que ya están al día se
 * saltean, que es lo que hace que un solo botón pueda recorrer todo el
 * historial sin tardar minutos cada vez.
 */
export const ORDER_SYNC_VERSION = 1;

export interface SyncResult {
  productsSynced: number;
  ordersSynced: number;
  adsRowsSynced: number;
  billingChargesSynced: number;
  fullStockSynced: number;
}

interface ProductColumnFlags {
  hasCategory: boolean;
  hasThumbnail: boolean;
  hasLogistics: boolean;
}

/**
 * Columnas opcionales de `products` (llegan por migración manual), armadas
 * en un solo lugar en vez de en cada función que hace upsert. Repetir esta
 * lista en dos lugares es exactamente cómo se coló el bug real: al agregar
 * logistic_type/inventory_id acá, la otra copia se quedó actualizando
 * nomás el título y descartando esos campos cuando el producto ya existía
 * como ficha mínima de una corrida anterior.
 */
function buildOptionalProductColumns(
  p: { categoryId?: string | null; categoryName?: string | null; thumbnail?: string | null; logisticType?: string | null; inventoryId?: string | null } | undefined,
  flags: ProductColumnFlags,
  updateOnConflict: boolean
): { cols: string[]; vals: unknown[]; updateSet: string[] } {
  const cols: string[] = [];
  const vals: unknown[] = [];
  const updateSet: string[] = [];
  if (flags.hasCategory) {
    cols.push("category_id", "category_name");
    vals.push(p?.categoryId ?? null, p?.categoryName ?? null);
    if (updateOnConflict) updateSet.push("category_id = excluded.category_id", "category_name = excluded.category_name");
  }
  if (flags.hasThumbnail) {
    cols.push("thumbnail");
    vals.push(p?.thumbnail ?? null);
    if (updateOnConflict) updateSet.push("thumbnail = excluded.thumbnail");
  }
  if (flags.hasLogistics) {
    cols.push("logistic_type", "inventory_id");
    vals.push(p?.logisticType ?? null, p?.inventoryId ?? null);
    if (updateOnConflict) updateSet.push("logistic_type = excluded.logistic_type", "inventory_id = excluded.inventory_id");
  }
  return { cols, vals, updateSet };
}

async function productColumnFlags(db: QueryExecutor): Promise<ProductColumnFlags> {
  return {
    hasCategory: await hasColumn(db, "products", "category_id"),
    hasThumbnail: await hasColumn(db, "products", "thumbnail"),
    hasLogistics: await hasColumn(db, "products", "logistic_type"),
  };
}

async function upsertProducts(
  db: QueryExecutor,
  accountId: string,
  products: MlProduct[],
  flags: ProductColumnFlags,
  now: string
): Promise<void> {
  for (const p of products) {
    const cols = ["account_id", "id", "title", "sku", "current_price", "stock", "permalink", "updated_at"];
    const vals: unknown[] = [accountId, p.id, p.title, p.sku, p.price, p.stock, p.permalink, now];
    const updateSet = [
      "title = excluded.title", "sku = excluded.sku", "current_price = excluded.current_price",
      "stock = excluded.stock", "permalink = excluded.permalink", "updated_at = excluded.updated_at",
    ];
    const extra = buildOptionalProductColumns(p, flags, true);
    cols.push(...extra.cols);
    vals.push(...extra.vals);
    updateSet.push(...extra.updateSet);
    const placeholders = vals.map((_, i) => `$${i + 1}`).join(", ");
    await db.query(
      `INSERT INTO products (${cols.join(", ")}) VALUES (${placeholders})
       ON CONFLICT (account_id, id) DO UPDATE SET ${updateSet.join(", ")}`,
      vals
    );
  }
}

/** Sincroniza el catálogo entero, sin cortar por tiempo. La usan `runSync` y
 * los tests; el endpoint real (`/api/sync`) usa `syncProductsPage` porque un
 * catálogo de decenas de miles de publicaciones no entra en una sola llamada. */
export async function syncProducts(db: QueryExecutor, accountId: string, sellerId: string): Promise<number> {
  const now = new Date().toISOString();
  const flags = await productColumnFlags(db);
  const products = await listProducts(accountId, sellerId);
  await upsertProducts(db, accountId, products, flags, now);
  return products.length;
}

export interface SyncProductsPageResult {
  productsSynced: number;
  /** Si viene, todavía queda catálogo por escanear: la próxima llamada tiene que mandar este scroll_id. */
  nextScrollId?: string;
}

/**
 * Igual que `syncProducts`, pero de una sola página con un límite de tiempo
 * (`deadline`) — para catálogos grandes que no entran en el tiempo de una
 * función serverless. `/api/sync` va llamando esto pasando el `nextScrollId`
 * de la respuesta anterior hasta que deja de venir, momento en el que el
 * catálogo entero ya quedó sincronizado.
 */
export async function syncProductsPage(
  db: QueryExecutor,
  accountId: string,
  sellerId: string,
  scrollId: string | undefined,
  deadline: number
): Promise<SyncProductsPageResult> {
  const now = new Date().toISOString();
  const flags = await productColumnFlags(db);
  const { ids, nextScrollId } = await scanProductIds(accountId, sellerId, scrollId, deadline);
  const products = await getProductDetails(accountId, ids);
  await upsertProducts(db, accountId, products, flags, now);
  return { productsSynced: products.length, nextScrollId };
}

/**
 * Procesa un lote concreto de órdenes. Es la parte cara —cada orden son dos
 * llamadas a la API de ML— así que el recálculo del historial la invoca por
 * tandas chicas en vez de todo de una.
 */
/**
 * De una lista de órdenes, cuáles hace falta volver a pedirle a la API: las
 * que no tenemos, o las guardadas con una versión vieja de la lógica.
 */
export async function pendingOrderIds(
  db: QueryExecutor,
  accountId: string,
  orderIds: string[]
): Promise<string[]> {
  if (orderIds.length === 0) return [];
  // Sin la columna de versión no se puede saber qué está al día: se
  // reprocesa todo, que es el comportamiento anterior.
  if (!(await hasColumn(db, "orders", "sync_version"))) return orderIds;

  const result = await db.query<{ id: string }>(
    `SELECT id FROM orders WHERE account_id = $1 AND id = ANY($2::text[]) AND sync_version >= $3`,
    [accountId, orderIds, ORDER_SYNC_VERSION]
  );
  const upToDate = new Set(result.rows.map((r) => String(r.id)));
  return orderIds.filter((id) => !upToDate.has(id));
}

export async function syncOrders(
  db: QueryExecutor,
  accountId: string,
  orderIds: string[],
  hasIva: boolean,
  otherTaxRate = 0,
  appliesIva = true
): Promise<number> {
  const hasVersion = await hasColumn(db, "orders", "sync_version");
  let synced = 0;

  // Cada orden le cuesta a Mercado Libre 1 o 2 llamadas (detalle + costo de
  // envío si tiene), y antes se pedían de a una, esperando que termine la
  // anterior sin ninguna razón para eso — no dependen entre sí. Con historial
  // grande (miles de órdenes) esa espera secuencial es la que hacía que el
  // sync por lotes tardara tanto. Se piden de a `ORDER_FETCH_CONCURRENCY` en
  // simultáneo — no todas juntas, para no gatillar el rate limit de ML — y
  // se procesan (e insertan) en el mismo orden de siempre.
  const ORDER_FETCH_CONCURRENCY = 10;
  for (let i = 0; i < orderIds.length; i += ORDER_FETCH_CONCURRENCY) {
    const chunk = orderIds.slice(i, i + ORDER_FETCH_CONCURRENCY);
    const orders = await Promise.all(chunk.map((orderId) => getOrderDetail(accountId, orderId)));
    for (const order of orders) {
      await db.query(
        `INSERT INTO orders (account_id, id, date_created, status, buyer_total${hasVersion ? ", sync_version" : ""})
         VALUES ($1, $2, $3, $4, $5${hasVersion ? ", $6" : ""})
         ON CONFLICT (account_id, id) DO UPDATE SET status = excluded.status, buyer_total = excluded.buyer_total${
           hasVersion ? ", sync_version = excluded.sync_version" : ""
         }`,
        [accountId, order.id, order.dateCreated, order.status, order.buyerTotal, ...(hasVersion ? [ORDER_SYNC_VERSION] : [])]
      );
      await db.query(`DELETE FROM order_items WHERE account_id = $1 AND order_id = $2`, [accountId, order.id]);

      for (const item of order.items) {
        // Un producto que se vendió pero ya no está publicado no vuelve en
        // /users/{id}/items, así que no tiene fila en `products` y por lo tanto
        // no aparece en la pantalla Productos: el vendedor no tiene dónde
        // cargarle el costo y esas ventas quedan para siempre fuera de la
        // ganancia neta, sin explicación. Se crea una ficha mínima con el
        // título que quedó en la venta. DO NOTHING: si el producto sí está en
        // el catálogo, manda el dato real que trajo syncProducts.
        await db.query(
          `INSERT INTO products (account_id, id, title, current_price, stock, updated_at)
           VALUES ($1, $2, $3, $4, 0, $5)
           ON CONFLICT (account_id, id) DO UPDATE SET
           title = CASE WHEN products.title = products.id THEN excluded.title ELSE products.title END`,
          [accountId, item.productId, item.productTitle || item.productId, item.unitPrice, order.dateCreated]
        );

        const costsResult = await db.query<{ cost: number; tax: number; validfrom: string | Date }>(
          `SELECT cost, tax, valid_from as validFrom FROM product_costs WHERE account_id = $1 AND product_id = $2`,
          [accountId, item.productId]
        );
        const costs = costsResult.rows.map((r) => ({
          cost: Number(r.cost),
          tax: Number(r.tax),
          validFrom: new Date(r.validfrom).toISOString(),
        }));
        const entry = getCostEntryAtDate(costs, order.dateCreated);
        const profitInput = {
          unitPrice: item.unitPrice,
          quantity: item.quantity,
          mlCommission: item.mlCommission,
          shippingCost: item.shippingCost,
          adsCostAllocated: 0,
          costApplied: entry?.cost ?? null,
          // Otros impuestos salen de la alícuota de la cuenta aplicada al precio,
          // no de un valor cargado producto por producto.
          taxApplied: item.unitPrice * otherTaxRate,
          appliesIva,
        };
        await db.query(
          `INSERT INTO order_items
             (account_id, order_id, product_id, unit_price, quantity, ml_commission, shipping_cost, ads_cost_allocated, cost_applied, tax_applied${hasIva ? ", iva_applied" : ""}, net_profit)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10${hasIva ? ", $12" : ""}, $11)`,
          [
            accountId, order.id, item.productId, item.unitPrice, item.quantity,
            item.mlCommission, item.shippingCost, 0,
            entry?.cost ?? null, profitInput.taxApplied,
            calculateNetProfit(profitInput),
            ...(hasIva ? [calculateIva(profitInput)] : []),
          ]
        );
      }
      synced += 1;
    }
  }
  return synced;
}

/** Tiempo máximo para pedirle el gasto a Mercado Ads dentro del paso de Ads. */
const ADS_FETCH_BUDGET_MS = 40_000;
/** Filas de ads_spend por INSERT. */
const ADS_INSERT_BATCH = 5_000;

export async function syncAds(
  db: QueryExecutor,
  accountId: string,
  sellerId: string,
  sinceIso: string
): Promise<number> {
  try {
    const dateTo = new Date().toISOString().slice(0, 10);
    // Se deja margen dentro de los 60 s de la función para borrar y guardar.
    // Si Mercado Ads no llega a contestar a tiempo, se corta ANTES de borrar
    // nada: el sync sigue con los datos de publicidad anteriores en vez de
    // quedar en 504 en cada reintento.
    const adsRows = await getAdsSpend(accountId, sellerId, sinceIso.slice(0, 10), dateTo, Date.now() + ADS_FETCH_BUDGET_MS);
    // Solo borra filas de Mercado Ads: las cargadas a mano (Meta/Google/TikTok)
    // tienen otro channel y no deben tocarse en un re-sync de ML.
    await db.query(
      `DELETE FROM ads_spend WHERE account_id = $1 AND channel = 'mercado_ads' AND date >= $2::date AND date <= $3::date`,
      [accountId, sinceIso.slice(0, 10), dateTo]
    );
    // Una fila por publicación por día son miles de filas: antes se escribían
    // de a una (una ida y vuelta a la base cada una) y solo eso ya se comía
    // el tiempo de la función. Ahora, un INSERT por tanda con arrays.
    for (let i = 0; i < adsRows.length; i += ADS_INSERT_BATCH) {
      const batch = adsRows.slice(i, i + ADS_INSERT_BATCH);
      await db.query(
        `INSERT INTO ads_spend (account_id, product_id, date, amount, channel)
         SELECT $1, p, d, a, 'mercado_ads'
           FROM unnest($2::text[], $3::date[], $4::double precision[]) AS t(p, d, a)`,
        [accountId, batch.map((r) => r.productId), batch.map((r) => r.date), batch.map((r) => r.amount)]
      );
    }
    return adsRows.length;
  } catch (err) {
    // Productos y órdenes ya se guardaron; si falla Mercado Ads el resto del
    // dashboard sigue funcionando, solo sin dato de publicidad.
    console.error("No se pudo sincronizar publicidad, se continúa sin ese dato:", (err as Error).message);
    return 0;
  }
}

/**
 * Cuántos inventory_id se piden por llamada. Una cuenta con un catálogo
 * grande en Full (miles de publicaciones) no entra en el tiempo de una sola
 * función junto con el resto del cierre del sync — se pedía TODO de una y,
 * para esas cuentas, el cierre entero (que además guarda publicidad y
 * facturación en la misma transacción) nunca llegaba a confirmarse.
 */
const FULL_STOCK_BATCH = 300;

/**
 * Actualiza la foto de stock guardado en Full de los productos que tienen
 * inventory_id. Corre al final, como syncAds: es informativo (valorización
 * de stock), no afecta ninguna venta ni ganancia neta, así que si falla no
 * tiene sentido tirar abajo el resto del sync.
 *
 * Por lotes de `FULL_STOCK_BATCH`, no todo de una: quien llama (ver
 * `/api/sync`) sigue pidiendo con el `nextOffset` devuelto hasta que da
 * `null`, en su propia llamada — así una cuenta con miles de inventory_id no
 * se come sola el presupuesto de tiempo del cierre entero.
 */
export async function syncFullStock(
  db: QueryExecutor,
  accountId: string,
  offset = 0
): Promise<{ synced: number; nextOffset: number | null }> {
  if (!(await hasColumn(db, "products", "inventory_id"))) return { synced: 0, nextOffset: null };
  try {
    // DISTINCT + orden estable: varias publicaciones pueden compartir un
    // mismo inventory_id (ver getFullStock), y sin un orden fijo la paginación
    // por offset podría saltear o repetir ids entre una llamada y la siguiente.
    const productsResult = await db.query<{ inventory_id: string }>(
      `SELECT DISTINCT inventory_id FROM products WHERE account_id = $1 AND inventory_id IS NOT NULL ORDER BY inventory_id`,
      [accountId]
    );
    const allIds = productsResult.rows.map((r) => r.inventory_id);
    if (allIds.length === 0) return { synced: 0, nextOffset: null };
    const batch = allIds.slice(offset, offset + FULL_STOCK_BATCH);
    if (batch.length === 0) return { synced: 0, nextOffset: null };

    const hasFullSince = await hasColumn(db, "products", "full_since");
    const stock = await getFullStock(accountId, batch);
    for (const s of stock) {
      // full_since se pisa solo si todavía está vacío: es la primera vez
      // que VIMOS este producto con stock en Full, no la fecha real de
      // ingreso al depósito (eso no lo expone la API de ML).
      await db.query(
        `UPDATE products SET full_stock_qty = $1, full_stock_unavailable_qty = $2${hasFullSince ? ", full_since = COALESCE(full_since, now())" : ""}
         WHERE account_id = $3 AND inventory_id = $4`,
        [s.availableQuantity, s.unavailableQuantity, accountId, s.inventoryId]
      );
    }
    const nextOffset = offset + FULL_STOCK_BATCH < allIds.length ? offset + FULL_STOCK_BATCH : null;
    return { synced: stock.length, nextOffset };
  } catch (err) {
    console.error("No se pudo sincronizar el stock de Full, se continúa sin ese dato:", (err as Error).message);
    return { synced: 0, nextOffset: null };
  }
}

/**
 * Rehace los números de las ventas de UN producto.
 *
 * Existe porque cargar un costo no puede depender de que después alguien
 * apriete "Sincronizar": el recálculo completo recorre todo el historial
 * contra la API de ML y solo corre al final del último lote, así que hasta
 * entonces el panel seguía diciendo "N líneas sin costo cargado" para un
 * producto que el vendedor acababa de completar. Acá no hace falta la API —
 * el costo cambia, no la venta— así que es una sola pasada por la base.
 *
 * La publicidad asignada no se toca: no depende del costo.
 */
/**
 * Le da ficha a los productos que se vendieron y no están en el catálogo.
 *
 * `/users/{id}/items/search` no devuelve las publicaciones dadas de baja, en
 * revisión o borradas, así que sus ventas quedaban apuntando a un product_id
 * sin fila en `products`. En el panel se veían como "MLA2293610632", sin
 * nombre ni foto, y el vendedor no tenía cómo reconocerlas para costearlas.
 *
 * Se piden esas publicaciones de a una por id —Mercado Libre sí las devuelve
 * por `/items`, aunque no las liste— y se guardan. Si alguna ya no existe ni
 * ahí, queda una ficha mínima con el id como nombre: sin fila en `products`
 * no hay dónde cargar el costo, y eso es peor que un nombre feo.
 */
export async function backfillMissingProducts(
  db: QueryExecutor,
  accountId: string,
  sellerId: string
): Promise<number> {
  // Se trae también UNA orden por producto: si la publicación fue borrada de
  // Mercado Libre, /items ya no la conoce, pero la orden guarda el nombre con
  // el que se vendió.
  const missing = await db.query<{ product_id: string; order_id: string }>(
    `SELECT oi.product_id, MIN(oi.order_id) as order_id
       FROM order_items oi
       LEFT JOIN products p ON p.account_id = oi.account_id AND p.id = oi.product_id
      WHERE oi.account_id = $1
        AND (
          p.id IS NULL
          -- Fichas mínimas de una corrida anterior: quedaron con el id como
          -- nombre porque en ese momento no se pudo resolver. Se reintenta,
          -- si no el nombre feo se queda para siempre.
          OR p.title = p.id
        )
      GROUP BY oi.product_id`,
    [accountId]
  );
  const ids = missing.rows.map((r) => r.product_id);
  if (ids.length === 0) return 0;

  const flags: ProductColumnFlags = {
    hasCategory: await hasColumn(db, "products", "category_id"),
    hasThumbnail: await hasColumn(db, "products", "thumbnail"),
    hasLogistics: await hasColumn(db, "products", "logistic_type"),
  };
  const now = new Date().toISOString();

  let saved = 0;
  const fetched = await getProductsByIds(accountId, ids);
  const byId = new Map(fetched.map((p) => [p.id, p]));

  // Para los que /items no reconoció, el nombre sale de la orden. Es una
  // llamada por producto irrecuperable, no por producto: los que sí están en
  // el catálogo ya se resolvieron de a 20 arriba.
  const fallbackTitles = new Map<string, string>();
  for (const row of missing.rows) {
    if (byId.has(row.product_id) || !row.order_id) continue;
    const titles = await getOrderItemTitles(accountId, row.order_id);
    const title = titles.get(row.product_id);
    if (title) fallbackTitles.set(row.product_id, title);
  }

  for (const id of ids) {
    const p = byId.get(id);
    const cols = ["account_id", "id", "title", "sku", "current_price", "stock", "permalink", "updated_at"];
    const vals: unknown[] = [
      accountId, id, p?.title ?? fallbackTitles.get(id) ?? id, p?.sku ?? null, p?.price ?? 0, p?.stock ?? 0, p?.permalink ?? null, now,
    ];
    const updateSet = ["title = CASE WHEN products.title = products.id THEN excluded.title ELSE products.title END"];
    // Esta corrida sí resolvió el producto de verdad contra /items: los
    // campos opcionales se refrescan. Si NO lo resolvió (p es undefined),
    // no se tocan — "excluded.*" traería nulls y borraría datos buenos que
    // una corrida anterior sí había conseguido.
    const extra = buildOptionalProductColumns(p, flags, p !== undefined);
    cols.push(...extra.cols);
    vals.push(...extra.vals);
    updateSet.push(...extra.updateSet);
    if (p) updateSet.push("sku = excluded.sku", "current_price = excluded.current_price", "stock = excluded.stock", "permalink = excluded.permalink");
    const placeholders = vals.map((_, i) => `$${i + 1}`).join(", ");
    await db.query(
      `INSERT INTO products (${cols.join(", ")}) VALUES (${placeholders})
       ON CONFLICT (account_id, id) DO UPDATE SET ${updateSet.join(", ")}`,
      vals
    );
    saved += 1;
  }
  return saved;
}

export async function recalculateProduct(
  db: QueryExecutor,
  accountId: string,
  productId: string,
  hasIva: boolean,
  otherTaxRate = 0,
  appliesIva = true
): Promise<number> {
  const costsResult = await db.query<{ cost: number; tax: number; validfrom: string | Date }>(
    `SELECT cost, tax, valid_from as validFrom FROM product_costs WHERE account_id = $1 AND product_id = $2`,
    [accountId, productId]
  );
  const costs = costsResult.rows.map((r) => ({
    cost: Number(r.cost),
    tax: Number(r.tax),
    validFrom: new Date(r.validfrom).toISOString(),
  }));

  const itemsResult = await db.query<OrderItemRow & { adscostallocated: number }>(
    `SELECT oi.id, oi.product_id as productId, oi.quantity, o.date_created as dateCreated,
            oi.unit_price as unitPrice, oi.ml_commission as mlCommission,
            oi.shipping_cost as shippingCost, oi.ads_cost_allocated as adsCostAllocated
     FROM order_items oi JOIN orders o ON o.account_id = oi.account_id AND o.id = oi.order_id
     WHERE oi.account_id = $1 AND oi.product_id = $2`,
    [accountId, productId]
  );

  for (const it of itemsResult.rows) {
    const entry = getCostEntryAtDate(costs, new Date(it.datecreated).toISOString());
    const profitInput = {
      unitPrice: Number(it.unitprice),
      quantity: Number(it.quantity),
      mlCommission: Number(it.mlcommission),
      shippingCost: Number(it.shippingcost),
      adsCostAllocated: Number(it.adscostallocated ?? 0),
      costApplied: entry?.cost ?? null,
      taxApplied: Number(it.unitprice) * otherTaxRate,
      appliesIva,
    };
    await db.query(
      `UPDATE order_items SET cost_applied = $1, tax_applied = $2, net_profit = $3${hasIva ? ", iva_applied = $5" : ""} WHERE id = $4`,
      [
        entry?.cost ?? null,
        profitInput.taxApplied,
        calculateNetProfit(profitInput),
        it.id,
        ...(hasIva ? [calculateIva(profitInput)] : []),
      ]
    );
  }
  return itemsResult.rows.length;
}

/**
 * Red de seguridad para "cargué el costo nuevo y el beneficio no cambió":
 * busca ventas cuyo costo aplicado no es el que corresponde según lo cargado
 * hoy (mismo criterio que getCostEntryAtDate: el último vigente a la fecha
 * de la venta, o el primero cargado si la venta es anterior a todos), solo
 * entre productos con un costo cargado hace poco — así es barato
 * aunque la cuenta tenga decenas de miles de ventas — y las recalcula.
 */
export async function healRecentCostEdits(
  db: QueryExecutor,
  accountId: string,
  hasIva: boolean,
  otherTaxRate = 0,
  appliesIva = true,
  sinceDays = 14
): Promise<string[]> {
  const stale = await db.query<{ productid: string }>(
    `SELECT DISTINCT oi.product_id as productId
       FROM order_items oi JOIN orders o ON o.account_id = oi.account_id AND o.id = oi.order_id
      WHERE oi.account_id = $1
        AND oi.product_id IN (
          SELECT product_id FROM product_costs
           WHERE account_id = $1 AND valid_from >= now() - ($2::int * interval '1 day')
        )
        AND oi.cost_applied IS DISTINCT FROM COALESCE(
          (SELECT pc.cost FROM product_costs pc
            WHERE pc.account_id = oi.account_id AND pc.product_id = oi.product_id AND pc.valid_from <= o.date_created
            ORDER BY pc.valid_from DESC LIMIT 1),
          (SELECT pc.cost FROM product_costs pc
            WHERE pc.account_id = oi.account_id AND pc.product_id = oi.product_id
            ORDER BY pc.valid_from ASC LIMIT 1)
        )
      LIMIT 50`,
    [accountId, sinceDays]
  );
  const ids = stale.rows.map((r) => r.productid);
  for (const productId of ids) {
    await recalculateProduct(db, accountId, productId, hasIva, otherTaxRate, appliesIva);
  }
  return ids;
}

export async function recalculate(
  db: QueryExecutor,
  accountId: string,
  hasIva: boolean,
  otherTaxRate = 0,
  appliesIva = true,
  offset = 0,
  deadline: number = Date.now() + RECALCULATE_TIME_BUDGET_MS,
  /** Solo para tests: probar la resumibilidad no debería depender de crear miles de filas reales. */
  batchSize = RECALCULATE_WRITE_BATCH
): Promise<{ done: boolean; nextOffset: number | null }> {
  return reallocateAdsCosts(db, accountId, hasIva, otherTaxRate, appliesIva, offset, deadline, batchSize);
}

export async function runSync(
  db: QueryExecutor,
  accountId: string,
  sellerId: string,
  sinceIso: string,
  otherTaxRate = 0,
  appliesIva = true
): Promise<SyncResult> {
  const hasIva = await hasColumn(db, "order_items", "iva_applied");

  const productsSynced = await syncProducts(db, accountId, sellerId);
  const orderIds = await listOrders(accountId, sellerId, sinceIso);
  const ordersSynced = await syncOrders(db, accountId, orderIds, hasIva, otherTaxRate, appliesIva);
  const adsRowsSynced = await syncAds(db, accountId, sellerId, sinceIso);
  await backfillMissingProducts(db, accountId, sellerId);
  const { synced: fullStockSynced } = await syncFullStock(db, accountId);
  await recalculate(db, accountId, hasIva, otherTaxRate, appliesIva);
  const billingChargesSynced = await syncBillingCharges(db, accountId);

  return { productsSynced, ordersSynced, adsRowsSynced, billingChargesSynced, fullStockSynced };
}

/**
 * Trae los cargos reales que Mercado Libre facturó (comisiones, envíos,
 * percepciones impositivas, Product Ads) para los últimos períodos.
 *
 * Es informativo por ahora: alimenta la conciliación "lo que ML te cobró vs.
 * lo que calculamos", pero NO entra todavía en la ganancia neta, porque
 * duplicaría la comisión y el envío que ya se descuentan por orden.
 *
 * Como todo lo de facturación puede fallar por permisos, un error acá no
 * rompe el resto del sync que ya se guardó.
 */
export async function syncBillingCharges(db: QueryExecutor, accountId: string): Promise<number> {
  try {
    if (!(await hasColumn(db, "billing_charges", "detail_id"))) return 0;

    const periods = await listBillingPeriods(accountId);
    // Los últimos 3 meses alcanzan para conciliar y acotan el volumen: los
    // períodos viejos ya están cerrados y no cambian.
    let saved = 0;
    // Diagnóstico: una investigación externa (sin confirmar) sostiene que
    // las devoluciones/cancelaciones no borran el cargo original sino que
    // ML agrega una fila propia con detail_type "BONUS" (sub_type BV/BXD/
    // BFF) como nota de crédito, y que hay un cargo punitivo aparte "CDSD"
    // por logística de devolución. classifyCharge() de sync/billing.ts hoy
    // solo entiende cargos con detail_type "CHARGE" — cualquier otro valor
    // cae sin clasificar. Antes de programar un neteo BONUS-contra-CHARGE
    // sobre códigos que nunca vimos en un log real, se junta evidencia:
    // cualquier detail_type distinto de CHARGE queda registrado acá (solo
    // el tipo/sub-tipo/concepto, y si viene o no con order_id — nunca un
    // monto) para confirmar o descartar la hipótesis con datos reales.
    const unexpectedTypes = new Map<
      string,
      { subTypes: Set<string>; concepts: Set<string>; withOrderId: number; withoutOrderId: number }
    >();
    for (const period of periods.slice(0, 3)) {
      for (const c of await getBillingCharges(accountId, period.key)) {
        if (c.detailType && c.detailType.toUpperCase() !== "CHARGE") {
          const entry = unexpectedTypes.get(c.detailType) ?? {
            subTypes: new Set(), concepts: new Set(), withOrderId: 0, withoutOrderId: 0,
          };
          if (c.detailSubType) entry.subTypes.add(c.detailSubType);
          if (c.concept) entry.concepts.add(c.concept);
          if (c.orderId) entry.withOrderId += 1; else entry.withoutOrderId += 1;
          unexpectedTypes.set(c.detailType, entry);
        }

        await db.query(
          `INSERT INTO billing_charges
             (account_id, detail_id, period_key, detail_type, detail_sub_type, concept, order_id, amount, charged_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (account_id, detail_id) DO UPDATE SET
             period_key = excluded.period_key, detail_type = excluded.detail_type,
             detail_sub_type = excluded.detail_sub_type, concept = excluded.concept,
             order_id = excluded.order_id, amount = excluded.amount, charged_at = excluded.charged_at`,
          [accountId, c.detailId, c.periodKey, c.detailType, c.detailSubType, c.concept, c.orderId, c.amount, c.chargedAt]
        );
        saved += 1;
      }
    }
    if (unexpectedTypes.size > 0) {
      const summary = [...unexpectedTypes.entries()].map(([type, e]) => ({
        detailType: type,
        detailSubTypes: [...e.subTypes],
        concepts: [...e.concepts],
        conOrderId: e.withOrderId,
        sinOrderId: e.withoutOrderId,
      }));
      console.warn("Facturación ML: detail_type distinto de 'CHARGE' encontrado:", JSON.stringify(summary));
    }
    return saved;
  } catch (err) {
    console.error("No se pudo sincronizar la facturación de ML, se continúa sin ese dato:", (err as Error).message);
    return 0;
  }
}

interface OrderItemRow {
  id: number;
  productid: string;
  quantity: number;
  datecreated: string | Date;
  unitprice: number;
  mlcommission: number;
  shippingcost: number;
}

/**
 * Cuántas líneas entran en un solo UPDATE ...FROM (VALUES ...). Antes se
 * escribía una consulta por línea, una atrás de la otra: para una cuenta con
 * decenas de miles de ventas eso solo, ya de por sí, se comía el presupuesto
 * de tiempo del cierre del sync entero (que también guarda publicidad, stock
 * de Full y facturación en la misma transacción) — el cierre nunca llegaba a
 * confirmarse para esas cuentas, así que ninguna de esas cuatro cosas quedaba
 * guardada nunca, por más veces que se reintentara.
 */
const RECALCULATE_WRITE_BATCH = 500;
const RECALCULATE_TIME_BUDGET_MS = 40_000;

/**
 * Por lotes y con presupuesto de tiempo: procesa desde `offset` hasta que se
 * termina o se acaba `deadline`, y devuelve por dónde seguir. Quien llama
 * (ver `/api/sync`) reintenta con el `nextOffset` en su propia llamada
 * mientras `done` sea false — mismo patrón que `syncFullStock` y
 * `syncProductsPage`.
 */
async function reallocateAdsCosts(
  db: QueryExecutor,
  accountId: string,
  hasIva: boolean,
  otherTaxRate = 0,
  appliesIva = true,
  offset = 0,
  deadline: number = Date.now() + RECALCULATE_TIME_BUDGET_MS,
  batchSize = RECALCULATE_WRITE_BATCH
): Promise<{ done: boolean; nextOffset: number | null }> {
  // Orden estable (por id): sin esto, la paginación por offset entre llamadas
  // podría saltear o repetir líneas si Postgres decidiera devolverlas en otro
  // orden de una consulta a la siguiente.
  const itemsResult = await db.query<OrderItemRow>(
    `SELECT oi.id, oi.product_id as productId, oi.quantity, o.date_created as dateCreated,
            oi.unit_price as unitPrice, oi.ml_commission as mlCommission,
            oi.shipping_cost as shippingCost
     FROM order_items oi JOIN orders o ON o.account_id = oi.account_id AND o.id = oi.order_id
     WHERE oi.account_id = $1
     ORDER BY oi.id`,
    [accountId]
  );
  const items = itemsResult.rows;
  if (items.length === 0) return { done: true, nextOffset: null };

  // Por producto+día (para el caso, hoy inexistente, de que un gasto SÍ
  // venga atado a una publicación puntual) y por día solo, para todo el
  // catálogo (para el caso real de hoy: ver más abajo).
  const unitsSoldByProductDate = new Map<string, number>();
  const unitsSoldByDate = new Map<string, number>();
  for (const it of items) {
    const dateStr = new Date(it.datecreated).toISOString().slice(0, 10);
    const key = `${it.productid}|${dateStr}`;
    unitsSoldByProductDate.set(key, (unitsSoldByProductDate.get(key) ?? 0) + Number(it.quantity));
    unitsSoldByDate.set(dateStr, (unitsSoldByDate.get(dateStr) ?? 0) + Number(it.quantity));
  }

  const adsResult = await db.query<{ productid: string | null; date: string | Date; amount: number }>(
    `SELECT product_id as productId, date, amount FROM ads_spend WHERE account_id = $1 AND channel = 'mercado_ads'`,
    [accountId]
  );
  const adsByProductDate = new Map<string, number>();
  // Mercado Ads dejó de discriminar el gasto por publicación (ver
  // getAdsSpend en mcp/tools.ts): TODO lo que llega hoy tiene product_id
  // null. Antes esto se guardaba igual en `adsByProductDate` con clave
  // "null|fecha", que nunca podía matchear la clave real de una línea de
  // venta ("MLA123|fecha") — el gasto en Ads terminaba SIEMPRE en $0 por
  // línea, sin ningún aviso, aunque la cuenta sí tuviera plata gastada real.
  // Ahora ese gasto sin publicación se guarda aparte, por día, y se reparte
  // entre TODAS las unidades vendidas ese día en toda la cuenta.
  const adsByDate = new Map<string, number>();
  for (const row of adsResult.rows) {
    const dateStr = row.date instanceof Date ? row.date.toISOString().slice(0, 10) : String(row.date).slice(0, 10);
    if (row.productid) {
      adsByProductDate.set(`${row.productid}|${dateStr}`, (adsByProductDate.get(`${row.productid}|${dateStr}`) ?? 0) + Number(row.amount));
    } else {
      adsByDate.set(dateStr, (adsByDate.get(dateStr) ?? 0) + Number(row.amount));
    }
  }

  // Recalculamos cost_applied acá también (no solo al insertar la orden): un
  // sync normal solo trae órdenes nuevas (ver sinceIso en /api/sync), así que
  // si cargás el costo de un producto después, las ventas viejas de ese
  // producto nunca se reinsertan — sin esto, se quedarían con cost_applied
  // congelado en null para siempre en vez de tomar el costo recién cargado.
  const loadCostsByProduct = async () => {
    const costsResult = await db.query<{ productid: string; cost: number; tax: number; validfrom: string | Date }>(
      `SELECT product_id as productId, cost, tax, valid_from as validFrom FROM product_costs WHERE account_id = $1`,
      [accountId]
    );
    const byProduct = new Map<string, { cost: number; tax: number; validFrom: string }[]>();
    for (const row of costsResult.rows) {
      const list = byProduct.get(row.productid) ?? [];
      list.push({ cost: Number(row.cost), tax: Number(row.tax), validFrom: new Date(row.validfrom).toISOString() });
      byProduct.set(row.productid, list);
    }
    return byProduct;
  };

  let i = offset;
  while (i < items.length) {
    // Siempre procesa al menos un lote, aunque el presupuesto ya esté
    // agotado al entrar: evita quedar en un ciclo de "no avanzó nada" si a
    // quien llama se le ocurre pasar un deadline ya vencido.
    if (i > offset && Date.now() >= deadline) break;

    // Los costos se releen en CADA lote, no una sola vez al arrancar: esta
    // pasada puede durar decenas de segundos, y si el vendedor corrige un
    // costo mientras tanto, un lote armado con la foto vieja pisaba el
    // recálculo recién hecho — el margen mostraba el costo nuevo pero el
    // beneficio quedaba congelado con el viejo.
    const costsByProduct = await loadCostsByProduct();

    const batch = items.slice(i, i + batchSize);
    const values: unknown[] = [];
    const valueRows: string[] = [];
    const cols = hasIva ? 6 : 5;
    batch.forEach((it, idx) => {
      const dateStr = new Date(it.datecreated).toISOString().slice(0, 10);
      const productDateKey = `${it.productid}|${dateStr}`;
      // Gasto sin publicación asociada (todo Mercado Ads hoy): se reparte
      // entre todas las unidades vendidas ESE DÍA en toda la cuenta, no solo
      // las de este producto — es la única base real que hay para repartirlo.
      const unattributedAds = allocateAdsCost(
        adsByDate.get(dateStr) ?? 0,
        unitsSoldByDate.get(dateStr) ?? 0,
        Number(it.quantity)
      );
      // Gasto atado a esta publicación puntual (si alguna vez vuelve a venir
      // así, o se carga a mano para un producto): se reparte solo entre las
      // unidades de este producto ese día. Nunca se pisan entre sí: una fila
      // de ads_spend tiene product_id o no lo tiene, nunca las dos cosas.
      const attributedAds = allocateAdsCost(
        adsByProductDate.get(productDateKey) ?? 0,
        unitsSoldByProductDate.get(productDateKey) ?? 0,
        Number(it.quantity)
      );
      const adsCostAllocated = unattributedAds + attributedAds;
      const entry = getCostEntryAtDate(costsByProduct.get(it.productid) ?? [], new Date(it.datecreated).toISOString());
      const profitInput = {
        unitPrice: Number(it.unitprice),
        quantity: Number(it.quantity),
        mlCommission: Number(it.mlcommission),
        shippingCost: Number(it.shippingcost),
        adsCostAllocated,
        costApplied: entry?.cost ?? null,
        taxApplied: Number(it.unitprice) * otherTaxRate,
        appliesIva,
      };
      values.push(it.id, adsCostAllocated, calculateNetProfit(profitInput), entry?.cost ?? null, profitInput.taxApplied);
      if (hasIva) values.push(calculateIva(profitInput));

      const base = idx * cols;
      const placeholders = Array.from({ length: cols }, (_, c) => `$${base + c + 1}`);
      // Sin un cast explícito acá, Postgres no tiene de dónde sacar el tipo
      // de cada columna del VALUES (todas son parámetros, ningún literal
      // tipado) y termina resolviéndolas como texto — recién ahí, al
      // asignarlas a columnas double precision en el UPDATE, tira "column
      // ... is of type double precision but expression is of type text".
      // Nunca apareció en los tests porque mockean db.query entero: solo se
      // ve contra un Postgres real, que es donde pasó en producción.
      const casts = ["bigint", "double precision", "double precision", "double precision", "double precision"];
      if (hasIva) casts.push("double precision");
      valueRows.push(`(${placeholders.map((p, c) => `${p}::${casts[c]}`).join(", ")})`);
    });

    await db.query(
      `UPDATE order_items AS oi SET
         ads_cost_allocated = v.ads_cost_allocated,
         net_profit = v.net_profit,
         cost_applied = v.cost_applied,
         tax_applied = v.tax_applied${hasIva ? ",\n         iva_applied = v.iva_applied" : ""}
       FROM (VALUES ${valueRows.join(", ")})
         AS v(id, ads_cost_allocated, net_profit, cost_applied, tax_applied${hasIva ? ", iva_applied" : ""})
       WHERE oi.id = v.id`,
      values
    );
    i += batch.length;
  }

  return { done: i >= items.length, nextOffset: i >= items.length ? null : i };
}
