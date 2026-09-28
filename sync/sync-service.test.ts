import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { nanoid } from "nanoid";

vi.mock("@/mcp/tools", () => ({
  listProducts: vi.fn(),
  scanProductIds: vi.fn(),
  getProductDetails: vi.fn(),
  listOrders: vi.fn(),
  getOrderDetail: vi.fn(),
  getAdsSpend: vi.fn(),
  getProductsByIds: vi.fn().mockResolvedValue([]),
  getOrderItemTitles: vi.fn().mockResolvedValue(new Map()),
  getFullStock: vi.fn().mockResolvedValue([]),
  listBillingPeriods: vi.fn().mockResolvedValue([]),
  getBillingCharges: vi.fn().mockResolvedValue([]),
}));

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL || "postgres://app_user:app_user_local_test_pw@localhost:5432/ml_dashboard_test";

/** Cuenta nueva y aislada por test. La usan los dos describes de este archivo. */
async function makeAccount() {
  const { withScope } = await import("@/db/client");
  const { createAccount } = await import("@/db/accounts");
  return withScope({ isAdmin: true }, (client) => createAccount(client, "Cuenta test", `sync.${nanoid(8)}@example.com`));
}

beforeAll(() => {
  process.env.DATABASE_URL = TEST_DATABASE_URL;
});

afterAll(async () => {
  const { closeDb } = await import("@/db/client");
  await closeDb();
});

describe("runSync", () => {
  it("persists products, orders and a computed net_profit per order item", async () => {
    const { listProducts, listOrders, getOrderDetail, getAdsSpend } = await import("@/mcp/tools");
    vi.mocked(listProducts).mockResolvedValueOnce([
      { id: "MLA1", title: "Producto 1", sku: "SKU1", price: 1000, stock: 5, permalink: "url", categoryId: "MLA1234", categoryName: "Categoría de prueba", thumbnail: null, logisticType: null, inventoryId: null },
    ]);
    vi.mocked(listOrders).mockResolvedValueOnce(["ORD1"]);
    vi.mocked(getOrderDetail).mockResolvedValueOnce({
      id: "ORD1",
      dateCreated: "2026-01-10T12:00:00Z",
      status: "paid",
      buyerTotal: 1000,
      items: [{ productId: "MLA1", productTitle: "Producto de prueba", unitPrice: 1000, quantity: 1, mlCommission: 130, shippingCost: 90 }],
    });
    vi.mocked(getAdsSpend).mockResolvedValueOnce([{ productId: "MLA1", date: "2026-01-10", amount: 50 }]);

    const { withScope } = await import("@/db/client");
    const { runSync } = await import("./sync-service");
    const account = await makeAccount();

    const result = await withScope({ accountId: account.id }, async (client) => {
      await client.query(`INSERT INTO product_costs (account_id, product_id, cost, valid_from) VALUES ($1, $2, $3, $4)`, [
        account.id,
        "MLA1",
        300,
        "2026-01-01",
      ]);
      return runSync(client, account.id, "SELLER1", "2026-01-01T00:00:00Z");
    });

    expect(result).toEqual({ productsSynced: 1, ordersSynced: 1, adsRowsSynced: 1, billingChargesSynced: 0, fullStockSynced: 0 });

    const item = await withScope({ accountId: account.id }, async (client) => {
      const r = await client.query<{ net_profit: number; cost_applied: number }>(
        `SELECT * FROM order_items WHERE account_id = $1 AND order_id = 'ORD1'`,
        [account.id]
      );
      return r.rows[0];
    });
    // 1000 − 130 − 90 − 50 − 300 = 430 antes de impuestos, menos el IVA que
    // esta venta le deja a pagar a ARCA: débito 21/121 de 1000, contra el
    // crédito de la comisión, el envío, la publicidad y el costo. Da 430/1,21,
    // que es la misma cuenta que calcular todo neto de IVA.
    expect(Number(item.net_profit)).toBeCloseTo(430 / 1.21, 6);
    expect(Number(item.cost_applied)).toBe(300);
  });

  it("leaves net_profit null when the product has no cost loaded", async () => {
    const { listProducts, listOrders, getOrderDetail, getAdsSpend } = await import("@/mcp/tools");
    vi.mocked(listProducts).mockResolvedValueOnce([]);
    vi.mocked(listOrders).mockResolvedValueOnce(["ORD2"]);
    vi.mocked(getOrderDetail).mockResolvedValueOnce({
      id: "ORD2",
      dateCreated: "2026-01-10T12:00:00Z",
      status: "paid",
      buyerTotal: 500,
      items: [{ productId: "MLA2", productTitle: "Producto de prueba", unitPrice: 500, quantity: 1, mlCommission: 65, shippingCost: 90 }],
    });
    vi.mocked(getAdsSpend).mockResolvedValueOnce([]);

    const { withScope } = await import("@/db/client");
    const { runSync } = await import("./sync-service");
    const account = await makeAccount();
    await withScope({ accountId: account.id }, (client) => runSync(client, account.id, "SELLER1", "2026-01-01T00:00:00Z"));

    const item = await withScope({ accountId: account.id }, async (client) => {
      const r = await client.query<{ net_profit: number | null; cost_applied: number | null }>(
        `SELECT * FROM order_items WHERE account_id = $1 AND order_id = 'ORD2'`,
        [account.id]
      );
      return r.rows[0];
    });
    expect(item.net_profit).toBeNull();
    expect(item.cost_applied).toBeNull();
  });

  it("re-running sync for the same order does not duplicate order_items", async () => {
    const { listProducts, listOrders, getOrderDetail, getAdsSpend } = await import("@/mcp/tools");
    vi.mocked(listProducts).mockResolvedValue([]);
    vi.mocked(listOrders).mockResolvedValue(["ORD3"]);
    vi.mocked(getOrderDetail).mockResolvedValue({
      id: "ORD3",
      dateCreated: "2026-01-10T12:00:00Z",
      status: "paid",
      buyerTotal: 500,
      items: [{ productId: "MLA3", productTitle: "Producto de prueba", unitPrice: 500, quantity: 1, mlCommission: 65, shippingCost: 90 }],
    });
    vi.mocked(getAdsSpend).mockResolvedValue([]);

    const { withScope } = await import("@/db/client");
    const { runSync } = await import("./sync-service");
    const account = await makeAccount();
    await withScope({ accountId: account.id }, (client) => runSync(client, account.id, "SELLER1", "2026-01-01T00:00:00Z"));
    await withScope({ accountId: account.id }, (client) => runSync(client, account.id, "SELLER1", "2026-01-01T00:00:00Z"));

    const count = await withScope({ accountId: account.id }, async (client) => {
      const r = await client.query<{ c: string }>(
        `SELECT COUNT(*) as c FROM order_items WHERE account_id = $1 AND order_id = 'ORD3'`,
        [account.id]
      );
      return Number(r.rows[0].c);
    });
    expect(count).toBe(1);
  });

  it("keeps products and orders synced even when getAdsSpend fails", async () => {
    const { listProducts, listOrders, getOrderDetail, getAdsSpend } = await import("@/mcp/tools");
    vi.mocked(listProducts).mockResolvedValueOnce([
      { id: "MLA4", title: "Producto 4", sku: null, price: 100, stock: 1, permalink: "url", categoryId: "MLA1234", categoryName: "Categoría de prueba", thumbnail: null, logisticType: null, inventoryId: null },
    ]);
    vi.mocked(listOrders).mockResolvedValueOnce(["ORD4"]);
    vi.mocked(getOrderDetail).mockResolvedValueOnce({
      id: "ORD4",
      dateCreated: "2026-01-10T12:00:00Z",
      status: "paid",
      buyerTotal: 100,
      items: [{ productId: "MLA4", productTitle: "Producto de prueba", unitPrice: 100, quantity: 1, mlCommission: 13, shippingCost: 20 }],
    });
    vi.mocked(getAdsSpend).mockRejectedValueOnce(new Error("Ads API no disponible"));

    const { withScope } = await import("@/db/client");
    const { runSync } = await import("./sync-service");
    const account = await makeAccount();

    const result = await withScope({ accountId: account.id }, (client) =>
      runSync(client, account.id, "SELLER1", "2026-01-01T00:00:00Z")
    );

    expect(result.productsSynced).toBe(1);
    expect(result.ordersSynced).toBe(1);
    expect(result.adsRowsSynced).toBe(0);

    const order = await withScope({ accountId: account.id }, async (client) => {
      const r = await client.query(`SELECT * FROM orders WHERE account_id = $1 AND id = 'ORD4'`, [account.id]);
      return r.rows[0];
    });
    expect(order).toBeTruthy();
  });
});

describe("syncProductsPage", () => {
  it("sincroniza los productos de la página y devuelve el nextScrollId cuando queda catálogo por escanear", async () => {
    // El caso real que motivó esto: un catálogo de decenas de miles de
    // publicaciones no entra en el tiempo de una función serverless. Acá se
    // prueba una sola página, verificando que efectivamente pasa el
    // scrollId/deadline recibidos y guarda lo que trajo esa página nomás.
    const { scanProductIds, getProductDetails } = await import("@/mcp/tools");
    vi.mocked(scanProductIds).mockResolvedValueOnce({ ids: ["MLA1", "MLA2"], nextScrollId: "scroll-next" });
    vi.mocked(getProductDetails).mockResolvedValueOnce([
      { id: "MLA1", title: "Producto 1", sku: null, price: 100, stock: 1, permalink: "url1", categoryId: null, categoryName: null, thumbnail: null, logisticType: null, inventoryId: null },
      { id: "MLA2", title: "Producto 2", sku: null, price: 200, stock: 2, permalink: "url2", categoryId: null, categoryName: null, thumbnail: null, logisticType: null, inventoryId: null },
    ]);

    const { withScope } = await import("@/db/client");
    const { syncProductsPage } = await import("./sync-service");
    const account = await makeAccount();
    const deadline = Date.now() + 1000;

    const result = await withScope({ accountId: account.id }, (client) =>
      syncProductsPage(client, account.id, "SELLER1", "scroll-prev", deadline)
    );

    expect(result).toEqual({ productsSynced: 2, nextScrollId: "scroll-next" });
    expect(vi.mocked(scanProductIds)).toHaveBeenCalledWith(account.id, "SELLER1", "scroll-prev", deadline);

    const rows = await withScope({ accountId: account.id }, async (client) => {
      const r = await client.query<{ id: string }>(`SELECT id FROM products WHERE account_id = $1 ORDER BY id`, [account.id]);
      return r.rows;
    });
    expect(rows.map((r) => r.id)).toEqual(["MLA1", "MLA2"]);
  });

  it("no devuelve nextScrollId cuando el catálogo entero entró en esta página", async () => {
    const { scanProductIds, getProductDetails } = await import("@/mcp/tools");
    vi.mocked(scanProductIds).mockResolvedValueOnce({ ids: ["MLA9"], nextScrollId: undefined });
    vi.mocked(getProductDetails).mockResolvedValueOnce([
      { id: "MLA9", title: "Producto 9", sku: null, price: 50, stock: 1, permalink: "url9", categoryId: null, categoryName: null, thumbnail: null, logisticType: null, inventoryId: null },
    ]);

    const { withScope } = await import("@/db/client");
    const { syncProductsPage } = await import("./sync-service");
    const account = await makeAccount();

    const result = await withScope({ accountId: account.id }, (client) =>
      syncProductsPage(client, account.id, "SELLER1", undefined, Date.now() + 1000)
    );

    expect(result).toEqual({ productsSynced: 1, nextScrollId: undefined });
  });
});

describe("syncOrders", () => {
  it("procesa todas las órdenes de un lote grande, aunque se pidan de a varias en simultáneo", async () => {
    // Antes se pedía el detalle de cada orden de a una, esperando a que
    // termine la anterior — con historiales grandes eso era el cuello de
    // botella real del sync. Ahora se piden de a ORDER_FETCH_CONCURRENCY (10)
    // en simultáneo; este test usa más órdenes que esa concurrencia (25) para
    // probar que ningún lote se pierde ni se procesa fuera de lugar.
    // Prefijo propio (no solo "ORD<n>") para no pisarse con los ids que usan
    // otros tests de este archivo — no hay un beforeEach que resetee mocks
    // acá, así que el conteo total de llamadas es acumulado entre tests.
    const { getOrderDetail } = await import("@/mcp/tools");
    const ORDER_COUNT = 25;
    const orderIds = Array.from({ length: ORDER_COUNT }, (_, i) => `BULK-ORD${i}`);
    vi.mocked(getOrderDetail).mockImplementation(async (_accountId: string, orderId: string) => ({
      id: orderId,
      dateCreated: "2026-01-10T12:00:00Z",
      status: "paid",
      buyerTotal: 100,
      items: [{ productId: `PROD-${orderId}`, productTitle: `Producto de ${orderId}`, unitPrice: 100, quantity: 1, mlCommission: 10, shippingCost: 5 }],
    }));

    const { withScope } = await import("@/db/client");
    const { syncOrders } = await import("./sync-service");
    const account = await makeAccount();

    const synced = await withScope({ accountId: account.id }, (client) =>
      syncOrders(client, account.id, orderIds, false)
    );

    expect(synced).toBe(ORDER_COUNT);
    const callsForThisBatch = vi.mocked(getOrderDetail).mock.calls.filter((c) => String(c[1]).startsWith("BULK-ORD"));
    expect(callsForThisBatch).toHaveLength(ORDER_COUNT);

    const rows = await withScope({ accountId: account.id }, async (client) => {
      const r = await client.query<{ id: string }>(`SELECT id FROM orders WHERE account_id = $1`, [account.id]);
      return r.rows;
    });
    expect(rows.map((r) => r.id).sort()).toEqual([...orderIds].sort());
  });
});

describe("backfillMissingProducts", () => {
  it("le pone nombre y foto a una publicación que ya no está en el catálogo", async () => {
    const { getProductsByIds } = await import("@/mcp/tools");
    const { withScope } = await import("@/db/client");
    const { backfillMissingProducts } = await import("./sync-service");
    const account = await makeAccount();

    vi.mocked(getProductsByIds).mockResolvedValueOnce([
      {
        id: "MLA999", title: "Luz De Emergencia 30 Led", sku: "SKU1", price: 12000,
        stock: 0, permalink: "https://ml/p", categoryId: null, categoryName: null,
        thumbnail: "https://thumb", logisticType: null, inventoryId: null,
      },
    ]);

    const saved = await withScope({ accountId: account.id }, async (client) => {
      await client.query(
        `INSERT INTO orders (account_id, id, date_created, status, buyer_total) VALUES ($1,'O1',now(),'paid',100)`,
        [account.id]
      );
      await client.query(
        `INSERT INTO order_items (account_id, order_id, product_id, unit_price, quantity, ml_commission, shipping_cost, ads_cost_allocated)
         VALUES ($1,'O1','MLA999',100,1,0,0,0)`,
        [account.id]
      );
      return backfillMissingProducts(client, account.id, "SELLER1");
    });

    expect(saved).toBe(1);
    const row = await withScope({ accountId: account.id }, async (client) => {
      const r = await client.query<{ title: string; thumbnail: string | null }>(
        `SELECT title, thumbnail FROM products WHERE account_id = $1 AND id = 'MLA999'`,
        [account.id]
      );
      return r.rows[0];
    });
    expect(row.title).toBe("Luz De Emergencia 30 Led");
    expect(row.thumbnail).toBe("https://thumb");
  });

  it("si la publicación fue borrada de ML, saca el nombre de la orden", async () => {
    // Es el caso real: /items ya no la conoce, pero la venta guarda el título
    // con el que se vendió. Sin esto queda como "MLA888" para siempre.
    const { getProductsByIds, getOrderItemTitles } = await import("@/mcp/tools");
    const { withScope } = await import("@/db/client");
    const { backfillMissingProducts } = await import("./sync-service");
    const account = await makeAccount();

    vi.mocked(getProductsByIds).mockResolvedValueOnce([]);
    vi.mocked(getOrderItemTitles).mockResolvedValueOnce(new Map([["MLA888", "Espejo Triple Touch"]]));

    await withScope({ accountId: account.id }, async (client) => {
      await client.query(
        `INSERT INTO orders (account_id, id, date_created, status, buyer_total) VALUES ($1,'O2',now(),'paid',100)`,
        [account.id]
      );
      await client.query(
        `INSERT INTO order_items (account_id, order_id, product_id, unit_price, quantity, ml_commission, shipping_cost, ads_cost_allocated)
         VALUES ($1,'O2','MLA888',100,1,0,0,0)`,
        [account.id]
      );
      return backfillMissingProducts(client, account.id, "SELLER1");
    });

    const title = await withScope({ accountId: account.id }, async (client) => {
      const r = await client.query<{ title: string }>(
        `SELECT title FROM products WHERE account_id = $1 AND id = 'MLA888'`,
        [account.id]
      );
      return r.rows[0]?.title;
    });
    expect(title).toBe("Espejo Triple Touch");
  });

  it("repara una ficha vieja que había quedado con el id como nombre", async () => {
    const { getProductsByIds, getOrderItemTitles } = await import("@/mcp/tools");
    const { withScope } = await import("@/db/client");
    const { backfillMissingProducts } = await import("./sync-service");
    const account = await makeAccount();

    vi.mocked(getProductsByIds).mockResolvedValueOnce([]);
    vi.mocked(getOrderItemTitles).mockResolvedValueOnce(new Map([["MLA777", "Nombre recuperado"]]));

    await withScope({ accountId: account.id }, async (client) => {
      await client.query(
        `INSERT INTO products (account_id, id, title, current_price, stock, updated_at) VALUES ($1,'MLA777','MLA777',0,0,now())`,
        [account.id]
      );
      await client.query(
        `INSERT INTO orders (account_id, id, date_created, status, buyer_total) VALUES ($1,'O3',now(),'paid',100)`,
        [account.id]
      );
      await client.query(
        `INSERT INTO order_items (account_id, order_id, product_id, unit_price, quantity, ml_commission, shipping_cost, ads_cost_allocated)
         VALUES ($1,'O3','MLA777',100,1,0,0,0)`,
        [account.id]
      );
      return backfillMissingProducts(client, account.id, "SELLER1");
    });

    const title = await withScope({ accountId: account.id }, async (client) => {
      const r = await client.query<{ title: string }>(
        `SELECT title FROM products WHERE account_id = $1 AND id = 'MLA777'`,
        [account.id]
      );
      return r.rows[0]?.title;
    });
    expect(title).toBe("Nombre recuperado");
  });

  it("cuando una ficha mínima sí se resuelve contra /items, refresca todos los campos opcionales, no solo el título", async () => {
    // El bug real: el UPDATE del ON CONFLICT solo tocaba `title`. Un producto
    // backfilleado que después SÍ aparece en /items (con categoría, foto,
    // logistic_type, inventory_id) se quedaba con esos campos en null para
    // siempre, aunque getProductsByIds los hubiera traído bien.
    const { getProductsByIds } = await import("@/mcp/tools");
    const { withScope } = await import("@/db/client");
    const { backfillMissingProducts } = await import("./sync-service");
    const account = await makeAccount();

    vi.mocked(getProductsByIds).mockResolvedValueOnce([
      {
        id: "MLA555", title: "Producto recuperado", sku: "SKU5", price: 5000, stock: 3,
        permalink: "https://ml/p5", categoryId: "MLA1", categoryName: "Categoría",
        thumbnail: "https://thumb5", logisticType: "fulfillment", inventoryId: "INV5",
      },
    ]);

    const saved = await withScope({ accountId: account.id }, async (client) => {
      // Ficha mínima de una corrida anterior: título = id, todo lo demás null.
      await client.query(
        `INSERT INTO products (account_id, id, title, current_price, stock, updated_at) VALUES ($1,'MLA555','MLA555',0,0,now())`,
        [account.id]
      );
      await client.query(
        `INSERT INTO orders (account_id, id, date_created, status, buyer_total) VALUES ($1,'O4',now(),'paid',100)`,
        [account.id]
      );
      await client.query(
        `INSERT INTO order_items (account_id, order_id, product_id, unit_price, quantity, ml_commission, shipping_cost, ads_cost_allocated)
         VALUES ($1,'O4','MLA555',100,1,0,0,0)`,
        [account.id]
      );
      return backfillMissingProducts(client, account.id, "SELLER1");
    });

    expect(saved).toBe(1);

    const row = await withScope({ accountId: account.id }, async (client) => {
      const r = await client.query(
        `SELECT title, sku, current_price as "currentPrice", stock, permalink, category_id as "categoryId",
                thumbnail, logistic_type as "logisticType", inventory_id as "inventoryId"
         FROM products WHERE account_id = $1 AND id = 'MLA555'`,
        [account.id]
      );
      return r.rows[0];
    });
    expect(row).toMatchObject({
      title: "Producto recuperado",
      sku: "SKU5",
      currentPrice: 5000,
      stock: 3,
      permalink: "https://ml/p5",
      categoryId: "MLA1",
      thumbnail: "https://thumb5",
      logisticType: "fulfillment",
      inventoryId: "INV5",
    });
  });
});

describe("syncFullStock", () => {
  it("guarda el stock y marca full_since la primera vez, sin pisarlo después", async () => {
    const { getFullStock } = await import("@/mcp/tools");
    const { withScope } = await import("@/db/client");
    const { syncFullStock } = await import("./sync-service");
    const account = await makeAccount();

    await withScope({ accountId: account.id }, (client) =>
      client.query(
        `INSERT INTO products (account_id, id, title, current_price, stock, inventory_id, updated_at)
         VALUES ($1,'MLA1','Producto',100,5,'INV1',now())`,
        [account.id]
      )
    );

    vi.mocked(getFullStock).mockResolvedValueOnce([
      { inventoryId: "INV1", availableQuantity: 8, unavailableQuantity: 1 },
    ]);
    const { synced, nextOffset } = await withScope({ accountId: account.id }, (client) => syncFullStock(client, account.id));
    expect(synced).toBe(1);
    expect(nextOffset).toBeNull();

    const first = await withScope({ accountId: account.id }, async (client) => {
      const r = await client.query<{ full_stock_qty: number; full_since: string }>(
        `SELECT full_stock_qty, full_since FROM products WHERE account_id = $1 AND id = 'MLA1'`,
        [account.id]
      );
      return r.rows[0];
    });
    expect(first.full_stock_qty).toBe(8);
    expect(first.full_since).toBeTruthy();

    // Un segundo sync con otra cantidad no debería mover full_since para
    // atrás: sigue siendo la primera vez que lo vimos, no la última.
    vi.mocked(getFullStock).mockResolvedValueOnce([
      { inventoryId: "INV1", availableQuantity: 3, unavailableQuantity: 0 },
    ]);
    await withScope({ accountId: account.id }, (client) => syncFullStock(client, account.id));

    const second = await withScope({ accountId: account.id }, async (client) => {
      const r = await client.query<{ full_stock_qty: number; full_since: string }>(
        `SELECT full_stock_qty, full_since FROM products WHERE account_id = $1 AND id = 'MLA1'`,
        [account.id]
      );
      return r.rows[0];
    });
    expect(second.full_stock_qty).toBe(3);
    expect(new Date(second.full_since).getTime()).toBe(new Date(first.full_since).getTime());
  });
});

describe("recalculate", () => {
  it("reparte el gasto de Mercado Ads sin publicación asociada entre TODAS las ventas de ese día, no solo las de un producto", async () => {
    // El bug real que corrige: Mercado Ads dejó de discriminar el gasto por
    // publicación (ver getAdsSpend en mcp/tools.ts) — todo lo que sincroniza
    // hoy llega con product_id NULL. La versión vieja de este cálculo
    // guardaba ese gasto bajo la clave "null|fecha" y después buscaba
    // "MLA1|fecha" para cada línea de venta: nunca matcheaban, así que
    // ads_cost_allocated quedaba siempre en $0 sin ningún aviso, aunque la
    // cuenta sí tuviera plata real gastada — la pestaña de Campañas mostraba
    // "sin gasto en publicidad" con presupuesto activo.
    const { withScope } = await import("@/db/client");
    const { recalculate } = await import("./sync-service");
    const account = await makeAccount();

    await withScope({ accountId: account.id }, async (client) => {
      await client.query(
        `INSERT INTO orders (account_id, id, date_created, status, buyer_total) VALUES ($1,'O1','2026-03-01', 'paid', 400)`,
        [account.id]
      );
      // MLA1 vende 3 unidades y MLA2 vende 1, el mismo día: 4 unidades en
      // total para repartir el gasto sin publicación asociada.
      await client.query(
        `INSERT INTO order_items (account_id, order_id, product_id, unit_price, quantity, ml_commission, shipping_cost, ads_cost_allocated)
         VALUES ($1,'O1','MLA1',100,3,0,0,0)`,
        [account.id]
      );
      await client.query(
        `INSERT INTO order_items (account_id, order_id, product_id, unit_price, quantity, ml_commission, shipping_cost, ads_cost_allocated)
         VALUES ($1,'O1','MLA2',100,1,0,0,0)`,
        [account.id]
      );
      // Gasto real de Mercado Ads ese día, sin ninguna publicación asociada
      // — el caso de siempre, hoy.
      await client.query(
        `INSERT INTO ads_spend (account_id, product_id, date, amount, channel) VALUES ($1,NULL,'2026-03-01',100,'mercado_ads')`,
        [account.id]
      );
    });

    await withScope({ accountId: account.id }, (client) => recalculate(client, account.id, false, 0, true));

    const rows = await withScope({ accountId: account.id }, async (client) => {
      const r = await client.query<{ product_id: string; ads_cost_allocated: number }>(
        `SELECT product_id, ads_cost_allocated FROM order_items WHERE account_id = $1 ORDER BY product_id`,
        [account.id]
      );
      return r.rows;
    });
    // Repartido proporcional a las unidades de cada línea: MLA1 (3/4 del
    // total) se lleva 75, MLA2 (1/4) se lleva 25 — nunca $0 los dos.
    expect(rows).toEqual([
      { product_id: "MLA1", ads_cost_allocated: 75 },
      { product_id: "MLA2", ads_cost_allocated: 25 },
    ]);
  });

  it("aplica el costo vigente, reparte la publicidad del día y calcula la ganancia neta de la línea", async () => {
    const { withScope } = await import("@/db/client");
    const { recalculate } = await import("./sync-service");
    const account = await makeAccount();

    await withScope({ accountId: account.id }, async (client) => {
      await client.query(
        `INSERT INTO orders (account_id, id, date_created, status, buyer_total) VALUES ($1,'O1','2026-02-01', 'paid', 2000)`,
        [account.id]
      );
      await client.query(
        `INSERT INTO order_items (account_id, order_id, product_id, unit_price, quantity, ml_commission, shipping_cost, ads_cost_allocated)
         VALUES ($1,'O1','MLA1',1000,2,130,0,0)`,
        [account.id]
      );
      await client.query(
        `INSERT INTO product_costs (account_id, product_id, cost, valid_from) VALUES ($1,'MLA1',300,'2026-01-01')`,
        [account.id]
      );
      // Gasto atado a una publicación puntual (no el caso real de hoy — ver
      // el test de arriba — pero sí lo que pasaría si ML alguna vez vuelve a
      // discriminar por publicación, o se carga a mano para un producto).
      // Única línea vendida ese día para ese producto: se lleva todo el gasto.
      await client.query(
        `INSERT INTO ads_spend (account_id, product_id, date, amount, channel) VALUES ($1,'MLA1','2026-02-01',40,'mercado_ads')`,
        [account.id]
      );
    });

    const result = await withScope({ accountId: account.id }, (client) =>
      recalculate(client, account.id, false, 0, false)
    );
    expect(result).toEqual({ done: true, nextOffset: null });

    const row = await withScope({ accountId: account.id }, async (client) => {
      const r = await client.query<{ cost_applied: number; ads_cost_allocated: number; tax_applied: number; net_profit: number }>(
        `SELECT cost_applied, ads_cost_allocated, tax_applied, net_profit FROM order_items WHERE account_id = $1 AND order_id = 'O1'`,
        [account.id]
      );
      return r.rows[0];
    });
    expect(row.cost_applied).toBe(300);
    expect(row.ads_cost_allocated).toBe(40);
    expect(row.tax_applied).toBe(0);
    // 1000*2 - comisión 130 - envío 0 - ads 40 - costo 300*2 - impuesto 0 - IVA 0.
    expect(row.net_profit).toBe(1230);
  });

  it("corta al agotar el presupuesto de tiempo y retoma desde el offset devuelto, sin saltear ni repetir filas", async () => {
    const { withScope } = await import("@/db/client");
    const { recalculate } = await import("./sync-service");
    const account = await makeAccount();

    await withScope({ accountId: account.id }, async (client) => {
      await client.query(
        `INSERT INTO orders (account_id, id, date_created, status, buyer_total) VALUES ($1,'O1',now(),'paid',300)`,
        [account.id]
      );
      for (const p of ["MLA1", "MLA2", "MLA3"]) {
        await client.query(
          `INSERT INTO order_items (account_id, order_id, product_id, unit_price, quantity, ml_commission, shipping_cost, ads_cost_allocated)
           VALUES ($1,'O1',$2,100,1,0,0,0)`,
          [account.id, p]
        );
      }
    });

    // Lotes de a 1, con el presupuesto de tiempo ya vencido: procesa una sola
    // fila por llamada (siempre al menos una, ver el comentario en
    // reallocateAdsCosts) y avisa por dónde seguir — el mismo patrón que
    // sigue el cliente real (ver SyncButton) para no perder ni repetir nada.
    let offset = 0;
    let done = false;
    let calls = 0;
    while (!done && calls < 10) {
      const result = await withScope({ accountId: account.id }, (client) =>
        recalculate(client, account.id, false, 0.1, false, offset, Date.now() - 1, 1)
      );
      done = result.done;
      offset = result.nextOffset ?? offset;
      calls += 1;
    }
    expect(calls).toBe(3);
    expect(done).toBe(true);

    const rows = await withScope({ accountId: account.id }, async (client) => {
      const r = await client.query<{ product_id: string; tax_applied: number }>(
        `SELECT product_id, tax_applied FROM order_items WHERE account_id = $1 ORDER BY product_id`,
        [account.id]
      );
      return r.rows;
    });
    // otherTaxRate=0.1 sobre unit_price=100: si alguna fila hubiera quedado
    // sin procesar, seguiría en null en vez de 10.
    expect(rows).toEqual([
      { product_id: "MLA1", tax_applied: 10 },
      { product_id: "MLA2", tax_applied: 10 },
      { product_id: "MLA3", tax_applied: 10 },
    ]);
  });
});

describe("syncBillingCharges", () => {
  it("no loguea nada cuando todos los cargos son detail_type CHARGE", async () => {
    const { listBillingPeriods, getBillingCharges } = await import("@/mcp/tools");
    vi.mocked(listBillingPeriods).mockResolvedValueOnce([
      { key: "P1", dateFrom: "2026-01-01", dateTo: "2026-01-31", amount: 100, periodStatus: "CLOSED" },
    ]);
    vi.mocked(getBillingCharges).mockResolvedValueOnce([
      { detailId: "D1", periodKey: "P1", detailType: "CHARGE", detailSubType: "CVFV", concept: "Comisión", orderId: "O1", amount: 50, chargedAt: null },
    ]);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { withScope } = await import("@/db/client");
    const { syncBillingCharges } = await import("./sync-service");
    const account = await makeAccount();
    const saved = await withScope({ accountId: account.id }, (client) => syncBillingCharges(client, account.id));

    expect(saved).toBe(1);
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("detail_type distinto"), expect.anything());
    warnSpy.mockRestore();
  });

  /**
   * Esto no confirma que "BONUS"/"BV" sean reales — es lo contrario: junta
   * evidencia real la próxima vez que corra un sync de verdad, en vez de
   * programar el neteo de notas de crédito sobre una investigación externa
   * sin verificar. Este test solo prueba que el diagnóstico se dispara y
   * agrupa bien, no que el código "BONUS" exista de verdad en la API.
   */
  it("loguea (sin exponer montos) cualquier detail_type distinto de CHARGE, agrupado por tipo", async () => {
    const { listBillingPeriods, getBillingCharges } = await import("@/mcp/tools");
    vi.mocked(listBillingPeriods).mockResolvedValueOnce([
      { key: "P1", dateFrom: "2026-01-01", dateTo: "2026-01-31", amount: 100, periodStatus: "CLOSED" },
    ]);
    vi.mocked(getBillingCharges).mockResolvedValueOnce([
      { detailId: "D1", periodKey: "P1", detailType: "CHARGE", detailSubType: "CVFV", concept: "Comisión", orderId: "O1", amount: 130, chargedAt: null },
      { detailId: "D2", periodKey: "P1", detailType: "BONUS", detailSubType: "BV", concept: "Devolución de comisión", orderId: "O1", amount: -130, chargedAt: null },
      { detailId: "D3", periodKey: "P1", detailType: "BONUS", detailSubType: "BV", concept: "Devolución de comisión", orderId: null, amount: -80, chargedAt: null },
    ]);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { withScope } = await import("@/db/client");
    const { syncBillingCharges } = await import("./sync-service");
    const account = await makeAccount();
    const saved = await withScope({ accountId: account.id }, (client) => syncBillingCharges(client, account.id));

    expect(saved).toBe(3);
    const call = warnSpy.mock.calls.find((c) => String(c[0]).includes("detail_type distinto"));
    expect(call).toBeTruthy();
    const summary = JSON.parse(call![1] as string);
    expect(summary).toEqual([
      { detailType: "BONUS", detailSubTypes: ["BV"], concepts: ["Devolución de comisión"], conOrderId: 1, sinOrderId: 1 },
    ]);
    // Ningún monto ($130, $-130, $-80) tiene que aparecer en lo logueado.
    const loggedText = JSON.stringify(warnSpy.mock.calls);
    expect(loggedText).not.toContain("130");
    expect(loggedText).not.toContain("80");
    warnSpy.mockRestore();
  });
});
