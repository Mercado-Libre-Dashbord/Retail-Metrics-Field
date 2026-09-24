import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./ml-client", async () => {
  const actual = await vi.importActual<typeof import("./ml-client")>("./ml-client");
  return { ...actual, mlFetch: vi.fn() };
});
vi.mock("./auth", () => ({ getValidAccessToken: vi.fn().mockResolvedValue("token") }));

import {
  listProducts,
  getOrderDetail,
  resolveLineCommissions,
  listOrders,
  listOrdersPage,
  listUnansweredQuestions,
  answerQuestion,
  updateProductPriceStock,
  getAdsSpend,
  listCampaigns,
  setCampaignStatus,
  splitIntoWindows,
  createSellerCoupon,
  listBillingPeriods,
  getStoreVisits,
  getProductsByIds,
  clampToAdsWindow,
  ADS_LOOKBACK_DAYS,
  getFullStock,
  probeProductAdsGranularity,
} from "./tools";
import { mlFetch, MlApiError } from "./ml-client";

describe("listProducts", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns an empty array when the seller has no active items", async () => {
    vi.mocked(mlFetch).mockResolvedValueOnce({ results: [] });
    expect(await listProducts("acc1", "123")).toEqual([]);
  });

  it("fetches details for each item id found in the search", async () => {
    vi.mocked(mlFetch)
      .mockResolvedValueOnce({ results: ["MLA1", "MLA2"] })
      .mockResolvedValueOnce([
        { body: { id: "MLA1", title: "Producto 1", seller_custom_field: "SKU1", price: 1000, available_quantity: 5, permalink: "url1" } },
        { body: { id: "MLA2", title: "Producto 2", seller_custom_field: null, price: 2000, available_quantity: 3, permalink: "url2" } },
      ]);
    const products = await listProducts("acc1", "123");
    expect(products).toHaveLength(2);
    expect(products[0]).toEqual({
      id: "MLA1", title: "Producto 1", sku: "SKU1", price: 1000, stock: 5, permalink: "url1",
      categoryId: null, categoryName: null, thumbnail: null, logisticType: null, inventoryId: null,
    });
  });

  it("reconoce un producto en Full por shipping.logistic_type, e ítems con variantes por variations[0].inventory_id", async () => {
    vi.mocked(mlFetch)
      .mockResolvedValueOnce({ results: ["MLA1", "MLA2"] })
      .mockResolvedValueOnce([
        { body: { id: "MLA1", title: "A", price: 1, available_quantity: 1, permalink: "", shipping: { logistic_type: "fulfillment" }, inventory_id: "INV1" } },
        { body: { id: "MLA2", title: "B", price: 1, available_quantity: 1, permalink: "", shipping: { logistic_type: "drop_off" }, variations: [{ inventory_id: "INV2" }] } },
      ]);

    const products = await listProducts("acc1", "123");

    expect(products[0]).toMatchObject({ logisticType: "fulfillment", inventoryId: "INV1" });
    expect(products[1]).toMatchObject({ logisticType: "drop_off", inventoryId: "INV2" });
  });

  it("avisa si ningún producto trae shipping.logistic_type reconocible", async () => {
    // Sin confirmar todavía contra una respuesta real: si el campo cambió de
    // nombre o de lugar, este aviso lo va a decir con las claves reales.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(mlFetch)
      .mockResolvedValueOnce({ results: ["MLA1"] })
      .mockResolvedValueOnce([{ body: { id: "MLA1", title: "A", price: 1, available_quantity: 1, permalink: "" } }]);

    await listProducts("acc1", "123");

    const warned = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(warned).toContain("logistic_type");
  });

  it("prefers the https thumbnail so the browser does not block it", async () => {
    vi.mocked(mlFetch)
      .mockResolvedValueOnce({ results: ["MLA1", "MLA2"] })
      .mockResolvedValueOnce([
        { body: { id: "MLA1", title: "A", price: 1, available_quantity: 1, permalink: "", secure_thumbnail: "https://x/a.jpg", thumbnail: "http://x/a.jpg" } },
        { body: { id: "MLA2", title: "B", price: 1, available_quantity: 1, permalink: "", thumbnail: "http://x/b.jpg" } },
      ]);

    const products = await listProducts("acc1", "123");

    expect(products[0].thumbnail).toBe("https://x/a.jpg");
    expect(products[1].thumbnail).toBe("http://x/b.jpg");
  });

  it("resolves each category name once, not once per product", async () => {
    vi.mocked(mlFetch)
      .mockResolvedValueOnce({ results: ["MLA1", "MLA2", "MLA3"] })
      .mockResolvedValueOnce([
        { body: { id: "MLA1", title: "A", price: 1, available_quantity: 1, permalink: "", category_id: "MLA111" } },
        { body: { id: "MLA2", title: "B", price: 1, available_quantity: 1, permalink: "", category_id: "MLA111" } },
        { body: { id: "MLA3", title: "C", price: 1, available_quantity: 1, permalink: "", category_id: "MLA222" } },
      ])
      .mockResolvedValueOnce({ name: "Camping" })
      .mockResolvedValueOnce({ name: "Cocina" });

    const products = await listProducts("acc1", "123");

    const categoryCalls = vi.mocked(mlFetch).mock.calls.filter((c) => String(c[0]).startsWith("/categories/"));
    expect(categoryCalls).toHaveLength(2);
    expect(products.map((p) => p.categoryName).sort()).toEqual(["Camping", "Camping", "Cocina"]);
  });

  it("keeps the product when its category name cannot be resolved", async () => {
    vi.mocked(mlFetch)
      .mockResolvedValueOnce({ results: ["MLA1"] })
      .mockResolvedValueOnce([
        { body: { id: "MLA1", title: "A", price: 1, available_quantity: 1, permalink: "", category_id: "MLA111" } },
      ])
      .mockRejectedValueOnce(new MlApiError(404, "not found"));

    const products = await listProducts("acc1", "123");

    expect(products).toHaveLength(1);
    expect(products[0].categoryId).toBe("MLA111");
    expect(products[0].categoryName).toBeNull();
  });

  it("batches the /items lookup in groups of 20 ids", async () => {
    const ids = Array.from({ length: 25 }, (_, i) => `MLA${i}`);
    const firstBatch = ids.slice(0, 20).map((id) => ({ body: { id, title: id, price: 1, available_quantity: 1, permalink: "" } }));
    const secondBatch = ids.slice(20).map((id) => ({ body: { id, title: id, price: 1, available_quantity: 1, permalink: "" } }));
    vi.mocked(mlFetch)
      .mockResolvedValueOnce({ results: ids })
      .mockResolvedValueOnce(firstBatch)
      .mockResolvedValueOnce(secondBatch);

    const products = await listProducts("acc1", "123");

    expect(products).toHaveLength(25);
    expect(vi.mocked(mlFetch)).toHaveBeenCalledTimes(3);
    expect(vi.mocked(mlFetch).mock.calls[1][0]).toContain(ids.slice(0, 20).join(","));
    expect(vi.mocked(mlFetch).mock.calls[2][0]).toContain(ids.slice(20).join(","));
  });

  it("no pierde ningún producto con un catálogo grande, aunque haya más tandas que la concurrencia máxima", async () => {
    // 300 ids -> 15 tandas de 20 (más que ITEMS_BATCH_CONCURRENCY=10). Antes
    // se pedían las 15 juntas con un solo Promise.all; con miles de ids reales
    // eso son cientos de pedidos simultáneos a la API de ML. Ahora se piden
    // de a 10 tandas en simultáneo — este test prueba que ningún producto se
    // pierde ni se duplica al cortar en más de un grupo.
    const ids = Array.from({ length: 300 }, (_, i) => `MLA${i}`);
    vi.mocked(mlFetch).mockImplementation(async (path: string) => {
      if (path.includes("items/search")) return { results: ids };
      const match = path.match(/ids=([^&]+)/);
      const batchIds = match ? match[1].split(",") : [];
      return batchIds.map((id) => ({ body: { id, title: id, price: 1, available_quantity: 1, permalink: "" } }));
    });

    const products = await listProducts("acc1", "123");

    expect(products.map((p) => p.id).sort()).toEqual([...ids].sort());
    // 1 llamada de búsqueda + 15 tandas de detalle de 20 ids cada una.
    expect(vi.mocked(mlFetch)).toHaveBeenCalledTimes(16);
  });

  it("pages through items/search with scroll_id when there are more results than one page", async () => {
    const firstPageIds = Array.from({ length: 50 }, (_, i) => `MLA${i}`);
    const secondPageIds = ["MLA50", "MLA51"];
    const allIds = [...firstPageIds, ...secondPageIds];
    const detailsFor = (ids: string[]) =>
      ids.map((id) => ({ body: { id, title: id, price: 1, available_quantity: 1, permalink: "" } }));

    vi.mocked(mlFetch)
      .mockResolvedValueOnce({ results: firstPageIds, scroll_id: "scroll-1" })
      .mockResolvedValueOnce({ results: secondPageIds, scroll_id: "scroll-1" })
      .mockResolvedValueOnce({ results: [] })
      .mockResolvedValueOnce(detailsFor(allIds.slice(0, 20)))
      .mockResolvedValueOnce(detailsFor(allIds.slice(20, 40)))
      .mockResolvedValueOnce(detailsFor(allIds.slice(40)));

    const products = await listProducts("acc1", "123");

    expect(products).toHaveLength(52);
    expect(vi.mocked(mlFetch).mock.calls[0][0]).toContain("search_type=scan");
    expect(vi.mocked(mlFetch).mock.calls[0][0]).not.toContain("scroll_id");
    expect(vi.mocked(mlFetch).mock.calls[1][0]).toContain("scroll_id=scroll-1");
    expect(vi.mocked(mlFetch).mock.calls[2][0]).toContain("scroll_id=scroll-1");
  });

  it("stops as soon as a page comes back without a scroll_id, even mid-catalog", async () => {
    vi.mocked(mlFetch)
      .mockResolvedValueOnce({ results: ["MLA1"] }) // sin scroll_id: no hay más para pedir
      .mockResolvedValueOnce([{ body: { id: "MLA1", title: "A", price: 1, available_quantity: 1, permalink: "" } }]);

    const products = await listProducts("acc1", "123");

    expect(products).toHaveLength(1);
    expect(vi.mocked(mlFetch)).toHaveBeenCalledTimes(2);
  });

  it("no se corta con el límite clásico de offset+limit<=1000 de ML: un catálogo grande sigue paginando por scroll_id", async () => {
    // Reproduce el caso real: una cuenta con más de 1000 publicaciones entre
    // activas/pausadas/cerradas. Con offset esto tiraba 400 "Invalid limit
    // and offset values" apenas offset pasaba de 1000 y el sync se caía
    // entero; con scroll_id no hay ese techo.
    const TOTAL_ITEMS = 1050;
    const allIds = Array.from({ length: TOTAL_ITEMS }, (_, i) => `MLA${i}`);
    const PAGE_SIZE = 50;
    for (let i = 0; i < TOTAL_ITEMS; i += PAGE_SIZE) {
      const page = allIds.slice(i, i + PAGE_SIZE);
      const isLast = i + PAGE_SIZE >= TOTAL_ITEMS;
      vi.mocked(mlFetch).mockResolvedValueOnce({ results: page, scroll_id: isLast ? undefined : "scroll-x" });
    }
    for (let i = 0; i < TOTAL_ITEMS; i += 20) {
      vi.mocked(mlFetch).mockResolvedValueOnce(
        allIds.slice(i, i + 20).map((id) => ({ body: { id, title: id, price: 1, available_quantity: 1, permalink: "" } }))
      );
    }

    const products = await listProducts("acc1", "123");

    expect(products).toHaveLength(TOTAL_ITEMS);
    const searchCalls = vi.mocked(mlFetch).mock.calls.map((c) => String(c[0])).filter((u) => u.includes("items/search"));
    expect(searchCalls.every((u) => !u.includes("offset="))).toBe(true);
  });
});

describe("listOrders", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns order ids from the search results", async () => {
    vi.mocked(mlFetch)
      .mockResolvedValueOnce({ results: [], paging: { total: 2 } }) // probe de densidad (ver findSafeOrderWindow)
      .mockResolvedValueOnce({ results: [{ id: 1 }, { id: 2 }], paging: { total: 2 } });
    // `today` cerca de `sinceIso` para que quede en una sola ventana de fecha
    // y el test no dependa de cuántos días separan al reloj real de esa fecha.
    expect(await listOrders("acc1", "123", "2026-01-01T00:00:00Z", new Date("2026-01-10"))).toEqual(["1", "2"]);
  });

  it("pages through every order instead of stopping at the first 50", async () => {
    const page = (n: number, from: number) => ({
      results: Array.from({ length: n }, (_, i) => ({ id: from + i })),
      paging: { total: 120 },
    });
    vi.mocked(mlFetch)
      .mockResolvedValueOnce({ results: [], paging: { total: 120 } }) // probe de densidad
      .mockResolvedValueOnce(page(50, 1))
      .mockResolvedValueOnce(page(50, 51))
      .mockResolvedValueOnce(page(20, 101));

    const ids = await listOrders("acc1", "S1", "2020-01-01T00:00:00Z", new Date("2020-02-01"));

    expect(ids).toHaveLength(120);
    expect(vi.mocked(mlFetch).mock.calls[2][0]).toContain("offset=50");
  });

  it("no pisa el techo de 10.000 de offset de /orders/search: un historial largo se parte en ventanas de fecha, con el offset reiniciado en cada una", async () => {
    // El caso real que motivó esto: ML rechaza con 400
    // "limit.maximum_exceeded" un offset mayor a 10.000 en /orders/search, sin
    // importar que esas órdenes estén repartidas en años de historial. Acá el
    // rango pedido (2020-01-01 a 2020-06-20, ~170 días) cruza dos ventanas de
    // 90 días — cada una tiene que arrancar con offset=0, no seguir sumando
    // sobre la ventana anterior.
    vi.mocked(mlFetch)
      .mockResolvedValueOnce({ results: [], paging: { total: 1 } }) // probe ventana 1
      .mockResolvedValueOnce({ results: [{ id: "A1" }], paging: { total: 1 } }) // fetch ventana 1
      .mockResolvedValueOnce({ results: [], paging: { total: 1 } }) // probe ventana 2
      .mockResolvedValueOnce({ results: [{ id: "B1" }], paging: { total: 1 } }); // fetch ventana 2

    const ids = await listOrders("acc1", "S1", "2020-01-01T00:00:00Z", new Date("2020-06-20"));

    expect(ids).toEqual(["A1", "B1"]);
    expect(vi.mocked(mlFetch)).toHaveBeenCalledTimes(4);
    expect(vi.mocked(mlFetch).mock.calls[1][0]).toContain("offset=0");
    expect(vi.mocked(mlFetch).mock.calls[3][0]).toContain("offset=0");
    // Ventanas de fecha distintas, no la misma repetida.
    const [firstFetchUrl, secondFetchUrl] = [vi.mocked(mlFetch).mock.calls[1][0], vi.mocked(mlFetch).mock.calls[3][0]].map(String);
    expect(firstFetchUrl).not.toBe(secondFetchUrl);
  });
});

describe("listOrdersPage", () => {
  beforeEach(() => vi.clearAllMocks());

  // Cada ventana nueva (offsetInWindow=0) se chequea primero con un `limit=1`
  // para saber si es segura (ver `findSafeOrderWindow`) antes de traer datos
  // de verdad — por eso casi todos los tests acá mockean un probe seguido de
  // la respuesta real.
  const safeProbe = { results: [], paging: { total: 10 } };

  it("trae hasta `limit` ids dentro de la ventana actual, después de confirmar que es segura", async () => {
    vi.mocked(mlFetch)
      .mockResolvedValueOnce(safeProbe) // probe: limit=1
      .mockResolvedValueOnce({ results: [{ id: "1" }, { id: "2" }], paging: { total: 10 } });

    const page = await listOrdersPage("acc1", "S1", "2020-01-01", "2020-12-31", 0, 2);

    expect(page).toEqual({ ids: ["1", "2"], nextFrom: "2020-01-01", nextOffsetInWindow: 2, done: false });
    expect(vi.mocked(mlFetch).mock.calls[0][0]).toContain("limit=1");
    expect(vi.mocked(mlFetch).mock.calls[1][0]).toContain("order.date_created.from=2020-01-01T00:00:00Z");
    expect(vi.mocked(mlFetch).mock.calls[1][0]).toContain("limit=2");
  });

  it("achica la ventana a la mitad cuando el probe dice que tiene más órdenes que el margen seguro, y la vuelve a chequear", async () => {
    // El caso real que motivó esto: una cuenta de altísimo volumen acumuló
    // casi 10.000 órdenes en una sola ventana de 90 días — el tamaño fijo no
    // alcanzaba. Acá el probe de la ventana completa (90 días) dice que tiene
    // 9.500 (por encima del margen seguro), así que se prueba con la mitad
    // (45 días) antes de traer nada.
    vi.mocked(mlFetch)
      .mockResolvedValueOnce({ results: [], paging: { total: 9500 } }) // probe de 90 días: densa
      .mockResolvedValueOnce({ results: [], paging: { total: 4000 } }) // probe de 45 días: segura
      .mockResolvedValueOnce({ results: [{ id: "1" }], paging: { total: 4000 } });

    // limit=1: alcanza con el primer id para completar el pedido, así el
    // test no depende de más llamadas que las tres que le importan acá.
    await listOrdersPage("acc1", "S1", "2020-01-01", "2020-12-31", 0, 1);

    expect(vi.mocked(mlFetch).mock.calls[0][0]).toContain("order.date_created.to=2020-03-30T23:59:59.999Z"); // 90 días
    expect(vi.mocked(mlFetch).mock.calls[1][0]).toContain("order.date_created.to=2020-02-14T23:59:59.999Z"); // 45 días
    expect(vi.mocked(mlFetch).mock.calls[2][0]).toContain("order.date_created.to=2020-02-14T23:59:59.999Z");
  });

  it("cruza a la ventana siguiente si la actual se termina antes de completar el límite pedido", async () => {
    vi.mocked(mlFetch)
      .mockResolvedValueOnce(safeProbe) // probe ventana 1
      .mockResolvedValueOnce({ results: [{ id: "last-of-window-1" }], paging: { total: 1 } })
      .mockResolvedValueOnce(safeProbe) // probe ventana 2
      .mockResolvedValueOnce({ results: [{ id: "first-of-window-2" }], paging: { total: 5 } });

    const page = await listOrdersPage("acc1", "S1", "2020-01-01", "2020-12-31", 0, 2);

    expect(page.ids).toEqual(["last-of-window-1", "first-of-window-2"]);
    expect(page.done).toBe(false);
    // La ventana 1 (90 días desde 2020-01-01) termina en 2020-03-30; la
    // próxima arranca al día siguiente.
    expect(vi.mocked(mlFetch).mock.calls[2][0]).toContain("order.date_created.from=2020-03-31T00:00:00Z");
    expect(page.nextFrom).toBe("2020-03-31");
    expect(page.nextOffsetInWindow).toBe(1);
  });

  it("devuelve done:true cuando ya no queda ninguna fecha con órdenes por delante de `today`", async () => {
    vi.mocked(mlFetch)
      .mockResolvedValueOnce({ results: [], paging: { total: 0 } }) // probe
      .mockResolvedValueOnce({ results: [], paging: { total: 0 } }); // fetch real, vacío

    const page = await listOrdersPage("acc1", "S1", "2020-01-01", "2020-01-01", 0, 50);

    expect(page).toEqual({ ids: [], nextFrom: "2020-01-02", nextOffsetInWindow: 0, done: true });
  });

  it("retoma desde el offset pedido en vez de arrancar de cero", async () => {
    vi.mocked(mlFetch)
      .mockResolvedValueOnce(safeProbe)
      // 5 ids de una: cubre el `limit` pedido en un solo pedido, así el
      // test no depende de si la ventana se termina después o no.
      .mockResolvedValueOnce({
        results: [{ id: "9" }, { id: "10" }, { id: "11" }, { id: "12" }, { id: "13" }],
        paging: { total: 40 },
      });

    await listOrdersPage("acc1", "S1", "2020-04-01", "2020-12-31", 30, 5);

    expect(vi.mocked(mlFetch).mock.calls[1][0]).toContain("order.date_created.from=2020-04-01T00:00:00Z");
    expect(vi.mocked(mlFetch).mock.calls[1][0]).toContain("offset=30");
  });
});

describe("getOrderDetail", () => {
  beforeEach(() => vi.clearAllMocks());

  it("maps order items, with no shipping charge when the order has no shipment", async () => {
    vi.mocked(mlFetch).mockResolvedValueOnce({
      id: 999,
      date_created: "2026-01-01T00:00:00Z",
      status: "paid",
      total_amount: 1000,
      order_items: [{ item: { id: "MLA1" }, unit_price: 500, quantity: 2, sale_fee: 65 }],
    });
    const order = await getOrderDetail("acc1", "999");
    // Sin título en la respuesta de ML, el id es el fallback: preferimos un
    // nombre feo antes que una ficha de producto sin nombre.
    // Sin pagos para contrastar, sale_fee se toma por unidad: 65 × 2.
    expect(order.items).toEqual([{ productId: "MLA1", productTitle: "MLA1", unitPrice: 500, quantity: 2, mlCommission: 130, shippingCost: 0 }]);
    // Sin shipment no se pide /shipments/.../costs.
    expect(vi.mocked(mlFetch)).toHaveBeenCalledTimes(1);
  });

  it("defaults shipping cost to 0 when the order has no shipping info", async () => {
    vi.mocked(mlFetch).mockResolvedValueOnce({
      id: 1000,
      date_created: "2026-01-01T00:00:00Z",
      status: "paid",
      total_amount: 500,
      order_items: [{ item: { id: "MLA1" }, unit_price: 500, quantity: 1, sale_fee: 65 }],
    });
    const order = await getOrderDetail("acc1", "1000");
    expect(order.items[0].shippingCost).toBe(0);
  });
});

describe("listUnansweredQuestions", () => {
  beforeEach(() => vi.clearAllMocks());

  it("maps ML's question shape to our own", async () => {
    vi.mocked(mlFetch).mockResolvedValueOnce({
      questions: [{ id: 55, item_id: "MLA1", text: "¿Tiene stock?", date_created: "2026-01-01T00:00:00Z" }],
    });
    const questions = await listUnansweredQuestions("acc1", "123");
    expect(questions).toEqual([{ id: 55, productId: "MLA1", text: "¿Tiene stock?", dateCreated: "2026-01-01T00:00:00Z" }]);
  });

  it("returns an empty array when there are no unanswered questions", async () => {
    vi.mocked(mlFetch).mockResolvedValueOnce({ questions: [] });
    expect(await listUnansweredQuestions("acc1", "123")).toEqual([]);
  });
});

describe("answerQuestion", () => {
  it("posts the question id and text to /answers", async () => {
    vi.mocked(mlFetch).mockResolvedValueOnce({});
    await answerQuestion("acc1", 55, "Sí, tenemos stock.");
    expect(vi.mocked(mlFetch)).toHaveBeenCalledWith(
      "/answers",
      "token",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ question_id: 55, text: "Sí, tenemos stock." }) })
    );
  });
});

describe("updateProductPriceStock", () => {
  it("PUTs only the fields that were passed", async () => {
    vi.mocked(mlFetch).mockResolvedValueOnce({});
    await updateProductPriceStock("acc1", "MLA1", { price: 21500 });
    expect(vi.mocked(mlFetch)).toHaveBeenCalledWith(
      "/items/MLA1",
      "token",
      expect.objectContaining({ method: "PUT", body: JSON.stringify({ price: 21500 }) })
    );
  });

  it("PUTs stock as available_quantity", async () => {
    vi.mocked(mlFetch).mockResolvedValueOnce({});
    await updateProductPriceStock("acc1", "MLA1", { stock: 10 });
    expect(vi.mocked(mlFetch)).toHaveBeenCalledWith(
      "/items/MLA1",
      "token",
      expect.objectContaining({ body: JSON.stringify({ available_quantity: 10 }) })
    );
  });
});

describe("getOrderDetail", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reads the seller's shipping cost from /shipments/{id}/costs, not from the order", async () => {
    vi.mocked(mlFetch)
      .mockResolvedValueOnce({
        id: 999,
        date_created: "2026-01-05T10:00:00Z",
        status: "paid",
        total_amount: 1000,
        shipping: { id: 5551 },
        order_items: [{ item: { id: "MLA1" }, unit_price: 1000, quantity: 1, sale_fee: 130 }],
      })
      .mockResolvedValueOnce({ senders: [{ cost: 420 }] });

    const order = await getOrderDetail("acc1", "999");

    expect(vi.mocked(mlFetch).mock.calls[1][0]).toBe("/shipments/5551/costs");
    expect(order.items[0].shippingCost).toBe(420);
  });

  it("splits one order's shipping across its lines instead of charging it to each", async () => {
    vi.mocked(mlFetch)
      .mockResolvedValueOnce({
        id: 999,
        date_created: "2026-01-05T10:00:00Z",
        status: "paid",
        total_amount: 1000,
        shipping: { id: 5551 },
        order_items: [
          { item: { id: "MLA1" }, unit_price: 750, quantity: 1, sale_fee: 100 },
          { item: { id: "MLA2" }, unit_price: 250, quantity: 1, sale_fee: 30 },
        ],
      })
      .mockResolvedValueOnce({ senders: [{ cost: 400 }] });

    const order = await getOrderDetail("acc1", "999");

    expect(order.items[0].shippingCost).toBeCloseTo(300);
    expect(order.items[1].shippingCost).toBeCloseTo(100);
    const total = order.items.reduce((s, i) => s + i.shippingCost, 0);
    expect(total).toBeCloseTo(400);
  });

  it("falls back to zero shipping instead of failing the order when the shipment lookup errors", async () => {
    vi.mocked(mlFetch)
      .mockResolvedValueOnce({
        id: 999,
        date_created: "2026-01-05T10:00:00Z",
        status: "paid",
        total_amount: 1000,
        shipping: { id: 5551 },
        order_items: [{ item: { id: "MLA1" }, unit_price: 1000, quantity: 1, sale_fee: 130 }],
      })
      .mockRejectedValueOnce(new MlApiError(403, "forbidden"));

    const order = await getOrderDetail("acc1", "999");
    expect(order.items[0].shippingCost).toBe(0);
  });

  it("charges no shipping when the buyer paid it (empty senders)", async () => {
    vi.mocked(mlFetch)
      .mockResolvedValueOnce({
        id: 999,
        date_created: "2026-01-05T10:00:00Z",
        status: "paid",
        total_amount: 1000,
        shipping: { id: 5551 },
        order_items: [{ item: { id: "MLA1" }, unit_price: 1000, quantity: 1, sale_fee: 130 }],
      })
      .mockResolvedValueOnce({ senders: [], receiver: { cost: 400 } });

    const order = await getOrderDetail("acc1", "999");
    expect(order.items[0].shippingCost).toBe(0);
  });
});

describe("splitIntoWindows", () => {
  it("keeps a short range as a single window", () => {
    expect(splitIntoWindows("2026-08-01", "2026-08-10")).toEqual([{ from: "2026-08-01", to: "2026-08-10" }]);
  });

  it("nunca arma una ventana que roce el límite de la API", () => {
    const windows = splitIntoWindows("2020-01-01", "2026-08-25");
    for (const w of windows) {
      const days = (Date.parse(`${w.to}T00:00:00Z`) - Date.parse(`${w.from}T00:00:00Z`)) / 86400000;
      // Con margen: la API rechazó un rango de 90 días contados inclusive.
      expect(days).toBeLessThanOrEqual(79);
    }
  });

  it("covers the range end to end with no gaps or overlaps", () => {
    const windows = splitIntoWindows("2026-01-01", "2026-08-25");
    expect(windows[0].from).toBe("2026-01-01");
    expect(windows[windows.length - 1].to).toBe("2026-08-25");
    for (let i = 1; i < windows.length; i += 1) {
      const prevEnd = Date.parse(`${windows[i - 1].to}T00:00:00Z`);
      const thisStart = Date.parse(`${windows[i].from}T00:00:00Z`);
      expect(thisStart - prevEnd).toBe(86400000);
    }
  });

  it("returns nothing for an inverted or invalid range", () => {
    expect(splitIntoWindows("2026-08-25", "2026-01-01")).toEqual([]);
    expect(splitIntoWindows("no-es-fecha", "2026-01-01")).toEqual([]);
  });
});

/** Fecha de hace N días, en el formato que usa la API. */
function haceDias(n: number): string {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
}

describe("getAdsSpend", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns an empty array when the account has no Product Ads advertiser", async () => {
    vi.mocked(mlFetch).mockResolvedValueOnce({ advertisers: [] });
    expect(await getAdsSpend("acc1", "123", haceDias(30), haceDias(1))).toEqual([]);
    expect(vi.mocked(mlFetch)).toHaveBeenCalledTimes(1);
  });

  it("returns no ad spend instead of failing the whole sync on a 404", async () => {
    vi.mocked(mlFetch)
      .mockResolvedValueOnce({ advertisers: [{ advertiser_id: 999, site_id: "MLA" }] })
      .mockRejectedValueOnce(new MlApiError(404, "advertiser_campaigns_not_found"));

    expect(await getAdsSpend("acc1", "123", haceDias(30), haceDias(1))).toEqual([]);
  });

  it("trae el costo REAL por publicación (no por campaña) y lo reparte por día dentro del rango", async () => {
    vi.mocked(mlFetch)
      .mockResolvedValueOnce({ advertisers: [{ advertiser_id: 999, site_id: "MLA" }] })
      .mockResolvedValueOnce({ results: [{ id: 1, metrics: { cost: 100 } }] }) // campaigns/search: solo para sacar un campaignId
      .mockResolvedValueOnce({ results: [{ item_id: "MLA1", metrics: { cost: 60 } }, { item_id: "MLA2", metrics: { cost: 40 } }] }); // ads/search

    const rows = await getAdsSpend("acc1", "123", haceDias(2), haceDias(1));

    // Ventana de 2 días: cada publicación reparte su costo real en partes
    // iguales entre esos días — ML tampoco discrimina por día en este
    // endpoint, pero ahora al menos es por PUBLICACIÓN, no por toda la cuenta.
    expect(rows).toEqual(
      expect.arrayContaining([
        { productId: "MLA1", date: haceDias(2), amount: 30 },
        { productId: "MLA1", date: haceDias(1), amount: 30 },
        { productId: "MLA2", date: haceDias(2), amount: 20 },
        { productId: "MLA2", date: haceDias(1), amount: 20 },
      ])
    );
    expect(rows).toHaveLength(4);
    expect(vi.mocked(mlFetch).mock.calls[2][0]).toBe(
      `/marketplace/advertising/MLA/advertisers/999/product_ads/ads/search?campaign_id=1&date_from=${haceDias(2)}&date_to=${haceDias(1)}&metrics=cost&limit=50&offset=0`
    );
    expect(vi.mocked(mlFetch).mock.calls[2][2]).toEqual(expect.objectContaining({ headers: { "Api-Version": "2" } }));
  });

  it("suma el costo de la misma publicación si aparece más de una vez (ej. en más de una campaña)", async () => {
    vi.mocked(mlFetch)
      .mockResolvedValueOnce({ advertisers: [{ advertiser_id: 999, site_id: "MLA" }] })
      .mockResolvedValueOnce({ results: [{ id: 1, metrics: { cost: 100 } }] })
      .mockResolvedValueOnce({ results: [{ item_id: "MLA1", metrics: { cost: 60 } }, { item_id: "MLA1", metrics: { cost: 40 } }] });

    const rows = await getAdsSpend("acc1", "123", haceDias(1), haceDias(1));

    expect(rows).toEqual([{ productId: "MLA1", date: haceDias(1), amount: 100 }]);
  });

  it("pagina ads/search hasta agotar el total, sumando el costo entre páginas", async () => {
    vi.mocked(mlFetch)
      .mockResolvedValueOnce({ advertisers: [{ advertiser_id: 999, site_id: "MLA" }] })
      .mockResolvedValueOnce({ results: [{ id: 1, metrics: { cost: 100 } }] })
      .mockResolvedValueOnce({ results: [{ item_id: "MLA1", metrics: { cost: 10 } }], paging: { total: 2 } })
      .mockResolvedValueOnce({ results: [{ item_id: "MLA2", metrics: { cost: 20 } }], paging: { total: 2 } });

    const rows = await getAdsSpend("acc1", "123", haceDias(1), haceDias(1));

    expect(rows).toEqual(
      expect.arrayContaining([
        { productId: "MLA1", date: haceDias(1), amount: 10 },
        { productId: "MLA2", date: haceDias(1), amount: 20 },
      ])
    );
    const adsCalls = vi.mocked(mlFetch).mock.calls.filter((c) => String(c[0]).includes("ads/search"));
    expect(adsCalls.map((c) => new URL(`https://x${c[0]}`).searchParams.get("offset"))).toEqual(["0", "1"]);
  });

  it("no pide ads/search cuando no hay ninguna campaña en el tramo", async () => {
    vi.mocked(mlFetch)
      .mockResolvedValueOnce({ advertisers: [{ advertiser_id: 999, site_id: "MLA" }] })
      .mockResolvedValueOnce({ results: [] });

    const rows = await getAdsSpend("acc1", "123", haceDias(1), haceDias(1));

    expect(rows).toEqual([]);
    expect(vi.mocked(mlFetch)).toHaveBeenCalledTimes(2);
  });

  it("parte un historial largo en ventanas cortas en vez de comerse un 400", async () => {
    vi.mocked(mlFetch)
      .mockResolvedValueOnce({ advertisers: [{ advertiser_id: 999, site_id: "MLA" }] })
      .mockResolvedValue({ results: [] });

    await getAdsSpend("acc1", "123", haceDias(2000), haceDias(0));

    const searchCalls = vi.mocked(mlFetch).mock.calls.filter((c) => String(c[0]).includes("campaigns/search"));
    expect(searchCalls.length).toBeGreaterThan(1);
    for (const call of searchCalls) {
      const url = new URL(`https://x${call[0]}`);
      const from = Date.parse(`${url.searchParams.get("date_from")}T00:00:00Z`);
      const to = Date.parse(`${url.searchParams.get("date_to")}T00:00:00Z`);
      expect((to - from) / 86400000).toBeLessThanOrEqual(89);
    }
  });
});

describe("probeProductAdsGranularity", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns advertiserFound: false when the account has no Product Ads advertiser", async () => {
    vi.mocked(mlFetch).mockResolvedValueOnce({ advertisers: [] });
    expect(await probeProductAdsGranularity("acc1")).toEqual({ advertiserFound: false });
  });

  it("returns campaignsFound: 0 without probing anything else when there are no campaigns yet", async () => {
    vi.mocked(mlFetch)
      .mockResolvedValueOnce({ advertisers: [{ advertiser_id: 999, site_id: "MLA" }] })
      .mockResolvedValueOnce({ results: [] });

    expect(await probeProductAdsGranularity("acc1")).toEqual({
      advertiserFound: true,
      campaignsFound: 0,
      campaignBudget: null,
      dailyWindowTest: null,
      itemLevelAttempts: [],
      itemMetricsCheck: null,
    });
    expect(vi.mocked(mlFetch)).toHaveBeenCalledTimes(2);
  });

  it("detects when the same campaign's cost genuinely differs across three far-apart single-day windows and none matches the configured budget, and reports item-level 404s as not confirmed", async () => {
    vi.mocked(mlFetch)
      .mockResolvedValueOnce({ advertisers: [{ advertiser_id: 999, site_id: "MLA" }] }) // getAdvertiserId
      .mockResolvedValueOnce({ results: [{ id: 1, name: "Campaña 1", status: "active", budget: 5000 }] }) // campaigns/search
      .mockResolvedValueOnce({ results: [{ id: 1, metrics: { cost: 300 } }] }) // costOnDay dateA
      .mockResolvedValueOnce({ results: [{ id: 1, metrics: { cost: 150 } }] }) // costOnDay dateB
      .mockResolvedValueOnce({ results: [{ id: 1, metrics: { cost: 700 } }] }) // costOnDay dateC
      .mockRejectedValueOnce(new MlApiError(404, "not_found")) // candidate path 1
      .mockRejectedValueOnce(new MlApiError(404, "not_found")) // candidate path 2
      .mockRejectedValueOnce(new MlApiError(404, "not_found")); // candidate path 3

    const result = await probeProductAdsGranularity("acc1");

    expect(result).toMatchObject({
      advertiserFound: true,
      campaignsFound: 1,
      campaignBudget: 5000,
      dailyWindowTest: { costA: 300, costB: 150, costC: 700, allDiffer: true, matchesBudget: false },
    });
    if ("itemLevelAttempts" in result) {
      expect(result.itemLevelAttempts).toHaveLength(3);
      for (const attempt of result.itemLevelAttempts) {
        expect(attempt.ok).toBe(false);
        expect(attempt.status).toBe(404);
      }
    }
  });

  it("flags matchesBudget when a sampled day's cost equals the campaign's configured budget", async () => {
    vi.mocked(mlFetch)
      .mockResolvedValueOnce({ advertisers: [{ advertiser_id: 999, site_id: "MLA" }] })
      .mockResolvedValueOnce({ results: [{ id: 1, name: "Campaña 1", status: "active", budget: 5000 }] })
      .mockResolvedValueOnce({ results: [{ id: 1, metrics: { cost: 5000 } }] }) // costOnDay dateA — igual al presupuesto
      .mockResolvedValueOnce({ results: [{ id: 1, metrics: { cost: 5000 } }] }) // costOnDay dateB
      .mockResolvedValueOnce({ results: [{ id: 1, metrics: { cost: 5000 } }] }) // costOnDay dateC
      .mockRejectedValueOnce(new MlApiError(404, "not_found"))
      .mockRejectedValueOnce(new MlApiError(404, "not_found"))
      .mockRejectedValueOnce(new MlApiError(404, "not_found"));

    const result = await probeProductAdsGranularity("acc1");

    expect(result).toMatchObject({
      dailyWindowTest: { allDiffer: false, matchesBudget: true },
    });
  });

  it("reports an item-level path as a real lead when it doesn't 404, and validates it with a real per-item, per-day comparison", async () => {
    vi.mocked(mlFetch)
      .mockResolvedValueOnce({ advertisers: [{ advertiser_id: 999, site_id: "MLA" }] })
      .mockResolvedValueOnce({ results: [{ id: 1, name: "Campaña 1", status: "active", budget: 5000 }] })
      .mockResolvedValueOnce({ results: [] }) // costOnDay dateA — sin coincidencia
      .mockResolvedValueOnce({ results: [] }) // costOnDay dateB
      .mockResolvedValueOnce({ results: [] }) // costOnDay dateC
      .mockResolvedValueOnce({ results: [{ item_id: "MLA1", cost: 50 }] }) // candidate path 1: ¡responde algo real!
      .mockRejectedValueOnce(new MlApiError(404, "not_found"))
      .mockRejectedValueOnce(new MlApiError(404, "not_found"))
      // itemMetricsCheck: re-pide la ruta que funcionó en dos días de un solo
      // día, con costos reales que cambian por ítem y por día.
      .mockResolvedValueOnce({
        results: [
          { item_id: "MLA1", campaign_id: 1, metrics: { cost: 30 } },
          { item_id: "MLA2", campaign_id: 1, metrics: { cost: 20 } },
        ],
      })
      .mockResolvedValueOnce({
        results: [
          { item_id: "MLA1", campaign_id: 1, metrics: { cost: 45 } },
          { item_id: "MLA2", campaign_id: 1, metrics: { cost: 15 } },
        ],
      });

    const result = await probeProductAdsGranularity("acc1");

    if ("itemLevelAttempts" in result) {
      expect(result.itemLevelAttempts[0]).toMatchObject({ ok: true, sampleKeys: ["item_id", "cost"] });
      expect(result.itemMetricsCheck).toMatchObject({
        itemsReturned: 2,
        itemsWithOtherCampaignId: 0,
        allItemsSameCost: false,
        anyItemCostDiffersByDay: true,
        perItem: [
          { itemId: "MLA1", costA: 30, costB: 45 },
          { itemId: "MLA2", costA: 20, costB: 15 },
        ],
      });
    } else {
      throw new Error("expected itemLevelAttempts in result");
    }
  });

  it("flags a filter that doesn't really filter, and per-item costs that never change, as red flags in itemMetricsCheck", async () => {
    vi.mocked(mlFetch)
      .mockResolvedValueOnce({ advertisers: [{ advertiser_id: 999, site_id: "MLA" }] })
      .mockResolvedValueOnce({ results: [{ id: 1, name: "Campaña 1", status: "active", budget: 5000 }] })
      .mockResolvedValueOnce({ results: [] })
      .mockResolvedValueOnce({ results: [] })
      .mockResolvedValueOnce({ results: [] })
      .mockResolvedValueOnce({ results: [{ item_id: "MLA1", cost: 50 }] })
      .mockRejectedValueOnce(new MlApiError(404, "not_found"))
      .mockRejectedValueOnce(new MlApiError(404, "not_found"))
      // Ambos días devuelven exactamente lo mismo, y un ítem viene de OTRA
      // campaña — las dos malas señales que un simple ok:true no detecta.
      .mockResolvedValueOnce({
        results: [
          { item_id: "MLA1", campaign_id: 1, metrics: { cost: 25 } },
          { item_id: "MLA2", campaign_id: 999, metrics: { cost: 25 } },
        ],
      })
      .mockResolvedValueOnce({
        results: [
          { item_id: "MLA1", campaign_id: 1, metrics: { cost: 25 } },
          { item_id: "MLA2", campaign_id: 999, metrics: { cost: 25 } },
        ],
      });

    const result = await probeProductAdsGranularity("acc1");

    if ("itemLevelAttempts" in result) {
      expect(result.itemMetricsCheck).toMatchObject({
        itemsWithOtherCampaignId: 1,
        allItemsSameCost: true,
        anyItemCostDiffersByDay: false,
      });
    } else {
      throw new Error("expected itemLevelAttempts in result");
    }
  });
});

describe("listCampaigns", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns an empty array when there is no advertiser", async () => {
    vi.mocked(mlFetch).mockResolvedValueOnce({ advertisers: [] });
    expect(await listCampaigns("acc1")).toEqual([]);
  });

  it("treats a 404 from Mercado Libre as 'no campaigns yet', not an error", async () => {
    vi.mocked(mlFetch)
      .mockResolvedValueOnce({ advertisers: [{ advertiser_id: 999, site_id: "MLA" }] })
      .mockRejectedValueOnce(new MlApiError(404, "advertiser_campaigns_not_found"));

    expect(await listCampaigns("acc1")).toEqual([]);
  });

  it("maps campaign fields", async () => {
    vi.mocked(mlFetch)
      .mockResolvedValueOnce({ advertisers: [{ advertiser_id: 999, site_id: "MLA" }] })
      .mockResolvedValueOnce({ results: [{ id: 1, name: "Campaña 1", status: "active", budget: 5000 }] });

    expect(await listCampaigns("acc1")).toEqual([{ id: "1", name: "Campaña 1", status: "active", budget: 5000 }]);
    const url = new URL(`https://x${vi.mocked(mlFetch).mock.calls[1][0]}`);
    expect(url.pathname).toBe("/marketplace/advertising/MLA/advertisers/999/product_ads/campaigns/search");
    // La API rechaza con 400 cualquier rango de más de 90 días.
    const from = Date.parse(`${url.searchParams.get("date_from")}T00:00:00Z`);
    const to = Date.parse(`${url.searchParams.get("date_to")}T00:00:00Z`);
    expect((to - from) / 86400000).toBeLessThanOrEqual(89);
  });
});

describe("setCampaignStatus", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws when there is no advertiser", async () => {
    vi.mocked(mlFetch).mockResolvedValueOnce({ advertisers: [] });
    await expect(setCampaignStatus("acc1", "1", "paused")).rejects.toBeInstanceOf(MlApiError);
  });

  it("PUTs the new status for the campaign", async () => {
    vi.mocked(mlFetch)
      .mockResolvedValueOnce({ advertisers: [{ advertiser_id: 999, site_id: "MLA" }] })
      .mockResolvedValueOnce({});

    await setCampaignStatus("acc1", "1", "paused");

    expect(vi.mocked(mlFetch)).toHaveBeenCalledWith(
      "/marketplace/advertising/MLA/advertisers/999/product_ads/campaigns/1",
      "token",
      expect.objectContaining({ method: "PUT", body: JSON.stringify({ status: "paused" }) })
    );
  });
});

describe("createSellerCoupon", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates a real Mercado Libre coupon campaign", async () => {
    vi.mocked(mlFetch).mockResolvedValueOnce({ id: 55, coupon_code: "GRACIAS", status: "active" });

    const coupon = await createSellerCoupon("acc1", {
      name: "Programa de fidelidad",
      amount: 2000,
      minPurchase: 10000,
      budget: 100000,
      durationDays: 30,
    });

    expect(coupon).toEqual({ id: "55", code: "GRACIAS", status: "active" });

    const [url, , init] = vi.mocked(mlFetch).mock.calls[0];
    expect(url).toBe("/seller-promotions/promotions");
    const body = JSON.parse((init as any).body);
    expect(body.promotion_type).toBe("SELLER_COUPON_CAMPAIGN");
    expect(body.fixed_amount).toBe(2000);
    expect(body.min_purchase_amount).toBe(10000);
    // El presupuesto es el tope duro: sin él un error de configuración podría
    // descontar sin límite.
    expect(body.budget).toBe(100000);
  });

  it("sets the campaign window from today for the requested days", async () => {
    vi.mocked(mlFetch).mockResolvedValueOnce({ id: 1 });

    await createSellerCoupon("acc1", { name: "x", amount: 1, minPurchase: 2, budget: 3, durationDays: 30 });

    const body = JSON.parse((vi.mocked(mlFetch).mock.calls[0][2] as any).body);
    const days = (Date.parse(body.finish_date) - Date.parse(body.start_date)) / 86400000;
    expect(days).toBeCloseTo(30, 1);
  });
});

describe("listBillingPeriods", () => {
  beforeEach(() => vi.clearAllMocks());

  it("manda document_type, que la API exige", async () => {
    // Sin este parámetro ML responde 422 y la conciliación con la factura
    // quedaba vacía sin que nada lo dijera: el sync captura el error y sigue.
    vi.mocked(mlFetch).mockResolvedValueOnce({ results: [] });

    await listBillingPeriods("acc1");

    const url = vi.mocked(mlFetch).mock.calls[0][0] as string;
    expect(url).toContain("document_type=BILL");
    expect(url).toContain("group=ML");
  });

  it("mapea los períodos y descarta los que no traen clave", async () => {
    vi.mocked(mlFetch).mockResolvedValueOnce({
      results: [
        { key: "2026-07-01", period: { date_from: "2026-07-01", date_to: "2026-07-31" }, amount: 1234.5, period_status: "CLOSED" },
        { period: { date_from: null, date_to: null }, amount: 0 },
      ],
    });

    const periods = await listBillingPeriods("acc1");

    expect(periods).toEqual([
      { key: "2026-07-01", dateFrom: "2026-07-01", dateTo: "2026-07-31", amount: 1234.5, periodStatus: "CLOSED" },
    ]);
  });
});

describe("getProductsByIds", () => {
  beforeEach(() => vi.clearAllMocks());

  it("trae publicaciones que ya no aparecen en el listado del vendedor", async () => {
    // Es el caso que rompía el panel: un producto vendido y dado de baja no
    // vuelve en /users/{id}/items/search, pero /items sí lo devuelve.
    vi.mocked(mlFetch).mockResolvedValueOnce([
      {
        code: 200,
        body: {
          id: "MLA2293610632", title: "Luz De Emergencia", seller_custom_field: "SKU9",
          price: 12000, available_quantity: 0, permalink: "https://ml/p",
          category_id: "MLA1", secure_thumbnail: "https://https-thumb",
        },
      },
    ]);
    vi.mocked(mlFetch).mockResolvedValueOnce({ id: "MLA1", name: "Iluminación" });

    const products = await getProductsByIds("acc1", ["MLA2293610632"]);

    expect(products).toHaveLength(1);
    expect(products[0]).toMatchObject({
      id: "MLA2293610632",
      title: "Luz De Emergencia",
      thumbnail: "https://https-thumb",
      categoryName: "Iluminación",
    });
  });

  it("saltea los ids que ML no reconoce en vez de perder toda la tanda", async () => {
    vi.mocked(mlFetch).mockResolvedValueOnce([
      { code: 404, body: {} },
      { code: 200, body: { id: "MLA2", title: "Existe", price: 10, available_quantity: 1, permalink: "u" } },
    ]);

    const products = await getProductsByIds("acc1", ["MLA1", "MLA2"]);

    expect(products.map((p) => p.id)).toEqual(["MLA2"]);
  });

  it("no llama a la API cuando no hay ids que pedir", async () => {
    expect(await getProductsByIds("acc1", [])).toEqual([]);
    expect(vi.mocked(mlFetch)).not.toHaveBeenCalled();
  });

  it("pide de a 20, que es el máximo que acepta /items", async () => {
    const ids = Array.from({ length: 45 }, (_, i) => `MLA${i}`);
    vi.mocked(mlFetch).mockResolvedValue([]);

    await getProductsByIds("acc1", ids);

    const itemCalls = vi.mocked(mlFetch).mock.calls.filter((c) => String(c[0]).startsWith("/items?ids="));
    expect(itemCalls).toHaveLength(3);
    expect(String(itemCalls[0][0]).split(",")).toHaveLength(20);
  });
});

describe("clampToAdsWindow", () => {
  const hoy = new Date("2026-08-30T12:00:00Z");

  it("adelanta una fecha vieja hasta donde la API contesta", () => {
    // Mercado Ads solo sirve métricas de los últimos 90 días corridos. El sync
    // del historial pedía desde 2020 y cada tramo viejo devolvía 400, así que
    // la publicidad no entraba nunca.
    expect(clampToAdsWindow("2020-01-01", hoy)).toBe(
      new Date(hoy.getTime() - ADS_LOOKBACK_DAYS * 86400000).toISOString().slice(0, 10)
    );
  });

  it("deja intacta una fecha que ya está dentro de la ventana", () => {
    expect(clampToAdsWindow("2026-08-20", hoy)).toBe("2026-08-20");
  });
});

describe("getAdsSpend fuera de la ventana", () => {
  beforeEach(() => vi.clearAllMocks());

  it("no le pide métricas a la API cuando todo el rango es más viejo de lo que sirve", async () => {
    vi.mocked(mlFetch).mockResolvedValueOnce({ advertisers: [{ advertiser_id: 999, site_id: "MLA" }] });

    const rows = await getAdsSpend("acc1", "123", "2020-01-01", "2020-03-31");

    expect(rows).toEqual([]);
    // Solo la llamada del advertiser: ninguna de campaigns/search.
    const searchCalls = vi.mocked(mlFetch).mock.calls.filter((c) => String(c[0]).includes("campaigns/search"));
    expect(searchCalls).toHaveLength(0);
  });
});

describe("getStoreVisits", () => {
  beforeEach(() => vi.clearAllMocks());

  it("manda fecha simple YYYY-MM-DD, sin armar un timestamp encima", async () => {
    // Bug real, en producción, dos veces: primero con "-00:00" y después con
    // "Z" agregado a un timestamp completo — ambos rechazados por ML con
    // "Invalid request unknown date format" (confirmado en logs reales). El
    // problema nunca fue el offset: la documentación oficial de ML muestra
    // el ejemplo con fecha simple ("date_from=2021-01-01"), sin hora.
    vi.mocked(mlFetch).mockResolvedValueOnce({ total_visits: 120 });

    await getStoreVisits("acc1", "123", "2026-08-01", "2026-08-31");

    const url = decodeURIComponent(vi.mocked(mlFetch).mock.calls[0][0] as string);
    expect(url).toContain("date_from=2026-08-01");
    expect(url).toContain("date_to=2026-08-31");
    expect(url).not.toContain("T00:00:00");
    expect(url).not.toContain("T23:59:59");
  });

  it("devuelve null (no 0) si la API falla, para no mostrar una conversión imposible", async () => {
    vi.mocked(mlFetch).mockRejectedValueOnce(new Error("400"));
    expect(await getStoreVisits("acc1", "123", "2026-08-01", "2026-08-31")).toBeNull();
  });
});

describe("getAdsSpend con publicaciones sin gasto reconocible", () => {
  beforeEach(() => vi.clearAllMocks());

  it("avisa con las claves reales de la respuesta cuando hay publicaciones pero ninguna aporta gasto", async () => {
    // Mismo caso real que antes (la pantalla de Campañas mostraba
    // presupuestos reales, pero Ad Spend daba $0), ahora a nivel publicación:
    // si el día de mañana ML vuelve a cambiar la forma de "ads/search", este
    // aviso va a decir cuál es el campo real en vez de quedar en silencio.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(mlFetch)
      .mockResolvedValueOnce({ advertisers: [{ advertiser_id: 999, site_id: "MLA" }] })
      .mockResolvedValueOnce({ results: [{ id: "C1", name: "Campaña real", status: "active", budget: 20000 }] })
      .mockResolvedValueOnce({ results: [{ item_id: "MLA1", title: "Producto" }] }); // sin metrics.cost

    const rows = await getAdsSpend("acc1", "123", haceDias(10), haceDias(1));

    expect(rows).toEqual([]);
    const warned = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(warned).toContain("publicaciones");
    expect(warned).toContain("Claves de la primera: item_id, title");
  });

  it("no avisa si la publicación trae metrics.cost, aunque el gasto real sea cero", async () => {
    // Un cero real (la publicación no gastó nada en el rango) no es lo mismo
    // que el campo no venir: eso sí sería una API que cambió de forma otra vez.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(mlFetch)
      .mockResolvedValueOnce({ advertisers: [{ advertiser_id: 999, site_id: "MLA" }] })
      .mockResolvedValueOnce({ results: [{ id: "C1" }] })
      .mockResolvedValueOnce({ results: [{ item_id: "MLA1", metrics: { cost: 0 } }] });

    const rows = await getAdsSpend("acc1", "123", haceDias(1), haceDias(1));

    expect(rows).toEqual([{ productId: "MLA1", date: haceDias(1), amount: 0 }]);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("getFullStock", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns an empty array without calling the API when there are no inventory ids", async () => {
    expect(await getFullStock("acc1", [])).toEqual([]);
    expect(mlFetch).not.toHaveBeenCalled();
  });

  it("pide el stock de cada inventory_id por separado (sin multi-get)", async () => {
    vi.mocked(mlFetch)
      .mockResolvedValueOnce({ available_quantity: 10, not_available_quantity: 2 })
      .mockResolvedValueOnce({ available_quantity: 5, not_available_quantity: 0 });

    const rows = await getFullStock("acc1", ["INV1", "INV2"]);

    expect(rows).toEqual(
      expect.arrayContaining([
        { inventoryId: "INV1", availableQuantity: 10, unavailableQuantity: 2 },
        { inventoryId: "INV2", availableQuantity: 5, unavailableQuantity: 0 },
      ])
    );
    expect(vi.mocked(mlFetch).mock.calls.map((c) => c[0])).toEqual(
      expect.arrayContaining(["/inventories/INV1/stock/fulfillment", "/inventories/INV2/stock/fulfillment"])
    );
  });

  it("no cae de la sincronización si un inventory_id da 404 (todavía sin stock en Full)", async () => {
    vi.mocked(mlFetch)
      .mockRejectedValueOnce(new MlApiError(404, "not found"))
      .mockResolvedValueOnce({ available_quantity: 3, not_available_quantity: 0 });

    const rows = await getFullStock("acc1", ["INV1", "INV2"]);

    expect(rows).toEqual([{ inventoryId: "INV2", availableQuantity: 3, unavailableQuantity: 0 }]);
  });

  it("avisa si ningún inventory_id trae 'available_quantity' reconocible", async () => {
    // Sin confirmar todavía: si el nombre real es otro, este aviso lo va a
    // decir con las claves reales de la respuesta.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(mlFetch).mockResolvedValueOnce({ total_quantity: 12 });

    const rows = await getFullStock("acc1", ["INV1"]);

    expect(rows).toEqual([]);
    const warned = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(warned).toContain("available_quantity");
    expect(warned).toContain("total_quantity");
  });

  it("no pide el mismo inventory_id más de una vez, aunque venga repetido (variaciones que comparten stock de Full)", async () => {
    // El caso real que motivó esto: varias filas de `products` (variaciones
    // de una misma publicación) comparten un inventory_id, y antes se le
    // pedía a ML el mismo dato una vez por cada fila que lo repetía en vez de
    // una vez por inventory_id real — con un catálogo grande, eso disparaba
    // decenas de pedidos duplicados en simultáneo y ML terminaba fallando
    // esas conexiones ("fetch failed").
    vi.mocked(mlFetch).mockResolvedValueOnce({ available_quantity: 7, not_available_quantity: 1 });

    const rows = await getFullStock("acc1", ["INV1", "INV1", "INV1"]);

    expect(rows).toEqual([{ inventoryId: "INV1", availableQuantity: 7, unavailableQuantity: 1 }]);
    expect(mlFetch).toHaveBeenCalledTimes(1);
  });

  it("no pierde ningún inventory_id con un catálogo grande, aunque haya más ids únicos que la concurrencia máxima", async () => {
    // 25 ids únicos, más que FULL_STOCK_CONCURRENCY=10 — antes se pedían
    // todos juntos con un solo Promise.all; con cientos de productos en Full
    // reales eso son cientos de pedidos simultáneos a la API de ML.
    const ids = Array.from({ length: 25 }, (_, i) => `INV${i}`);
    vi.mocked(mlFetch).mockImplementation(async (path: string) => {
      const id = path.split("/")[2];
      return { available_quantity: Number(id.replace("INV", "")), not_available_quantity: 0 };
    });

    const rows = await getFullStock("acc1", ids);

    expect(rows.map((r) => r.inventoryId).sort()).toEqual([...ids].sort());
    expect(mlFetch).toHaveBeenCalledTimes(25);
  });
});

describe("resolveLineCommissions", () => {
  const base = { id: 1, total_amount: 1000, order_items: [{ unit_price: 500, quantity: 2, sale_fee: 65 }] };

  it("con líneas de 1 unidad usa sale_fee tal cual, sin mirar los pagos", () => {
    const r = resolveLineCommissions({ ...base, order_items: [{ unit_price: 1000, quantity: 1, sale_fee: 130 }] });
    expect(r).toMatchObject({ commissions: [130], evidence: false });
  });

  it("si lo cobrado en los pagos coincide con sale_fee × cantidad, es por unidad", () => {
    const r = resolveLineCommissions({ ...base, payments: [{ status: "approved", transaction_amount: 1000, marketplace_fee: 130 }] });
    expect(r).toEqual({ commissions: [130], basis: "per_unit", evidence: true });
  });

  it("si lo cobrado coincide con sale_fee solo, es por línea", () => {
    const r = resolveLineCommissions({ ...base, payments: [{ status: "approved", transaction_amount: 1000, marketplace_fee: 65 }] });
    expect(r).toEqual({ commissions: [65], basis: "per_line", evidence: true });
  });

  it("ignora pagos que cubren más que esta orden (carrito) y usa la lectura por defecto", () => {
    const r = resolveLineCommissions({ ...base, payments: [{ status: "approved", transaction_amount: 3000, marketplace_fee: 65 }] });
    expect(r).toEqual({ commissions: [130], basis: "per_unit", evidence: false });
  });

  it("no cuenta pagos rechazados", () => {
    const r = resolveLineCommissions({
      ...base,
      payments: [
        { status: "rejected", transaction_amount: 1000, marketplace_fee: 65 },
        { status: "approved", transaction_amount: 1000, marketplace_fee: 130 },
      ],
    });
    expect(r.basis).toBe("per_unit");
    expect(r.evidence).toBe(true);
  });
});
