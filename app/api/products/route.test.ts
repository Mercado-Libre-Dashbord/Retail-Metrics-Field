import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/db/client", () => ({ withScope: vi.fn((ctx: unknown, fn: (client: unknown) => unknown) => fn({ query: vi.fn() })) }));
vi.mock("@/lib/current-account", () => ({ resolveCurrentAccount: vi.fn() }));

import { GET, PATCH, DELETE } from "./route";
import { withScope } from "@/db/client";
import { resolveCurrentAccount } from "@/lib/current-account";
import { resetColumnCache } from "@/db/schema-capabilities";

const account = { id: "acc1", name: "Cuenta", ownerEmail: "a@example.com", mlSellerId: "S1", otherTaxRate: 0, taxCondition: "responsable_inscripto" as const, taxConditionConfirmed: true, createdAt: "2026-01-01" };

function queryMock() {
  return vi.fn().mockImplementation(async (sql: string) => {
    if (sql.includes("information_schema.columns")) {
      return {
        rows: [
          { table_name: "products", column_name: "thumbnail" },
          { table_name: "products", column_name: "low_stock_threshold" },
        ],
      };
    }
    return { rows: [] };
  });
}

describe("PATCH /api/products", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetColumnCache();
    vi.mocked(resolveCurrentAccount).mockResolvedValue(account);
  });

  it("returns 401 when there is no active account", async () => {
    vi.mocked(resolveCurrentAccount).mockResolvedValue(null);
    const request = { json: async () => ({ productId: "MLA1", cost: 350 }) } as any;
    const res = await PATCH(request);
    expect(res.status).toBe(401);
  });

  it("returns 400 when cost is missing or negative", async () => {
    const request = { json: async () => ({ productId: "MLA1", cost: -5 }) } as any;
    const res = await PATCH(request);
    expect(res.status).toBe(400);
  });

  it("inserts a new versioned cost row scoped to the current account", async () => {
    const query = queryMock();
    vi.mocked(withScope).mockImplementation((ctx: any, fn: any) => fn({ query }));
    const request = { json: async () => ({ productId: "MLA1", cost: 350 }) } as any;

    const res = await PATCH(request);

    expect(await res.json()).toMatchObject({ ok: true });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO product_costs"), [
      "acc1",
      "MLA1",
      350,
      expect.any(String),
    ]);
  });

  it("applies the cost to that product's existing sales right away", async () => {
    // El bug que arregla: cargar un costo insertaba la fila y nada más. El
    // panel seguía contando esas líneas como "sin costo cargado" hasta que
    // alguien corriera un Sincronizar completo, así que parecía que la carga
    // no había tomado.
    const query = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("information_schema.columns")) {
        return { rows: [{ table_name: "order_items", column_name: "iva_applied" }] };
      }
      if (sql.includes("FROM product_costs")) {
        return { rows: [{ cost: 350, tax: 0, validfrom: "2026-01-01T00:00:00Z" }] };
      }
      if (sql.includes("FROM order_items oi JOIN orders o")) {
        return {
          rows: [
            {
              id: 7, productid: "MLA1", quantity: 2, datecreated: "2026-02-01T00:00:00Z",
              unitprice: 1000, mlcommission: 130, shippingcost: 0, adscostallocated: 0,
            },
          ],
        };
      }
      return { rows: [] };
    });
    vi.mocked(withScope).mockImplementation((ctx: any, fn: any) => fn({ query }));
    const request = { json: async () => ({ productId: "MLA1", cost: 350 }) } as any;

    const res = await PATCH(request);

    expect(await res.json()).toEqual({ ok: true, itemsUpdated: 1 });
    // La venta vieja queda con el costo recién cargado y su ganancia rehecha.
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE order_items SET cost_applied"),
      expect.arrayContaining([350, 7])
    );
  });

  it("returns 400 when neither cost nor lowStockThreshold is sent", async () => {
    const request = { json: async () => ({ productId: "MLA1" }) } as any;
    const res = await PATCH(request);
    expect(res.status).toBe(400);
  });

  it("sets a low stock threshold without touching the cost", async () => {
    const query = queryMock();
    vi.mocked(withScope).mockImplementation((ctx: any, fn: any) => fn({ query }));
    const request = { json: async () => ({ productId: "MLA1", lowStockThreshold: 5 }) } as any;

    const res = await PATCH(request);

    expect(await res.json()).toEqual({ ok: true, itemsUpdated: 0 });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE products SET low_stock_threshold"),
      [5, "acc1", "MLA1"]
    );
    expect(query).not.toHaveBeenCalledWith(expect.stringContaining("INSERT INTO product_costs"), expect.anything());
  });

  it("clears the low stock alert by sending null", async () => {
    const query = queryMock();
    vi.mocked(withScope).mockImplementation((ctx: any, fn: any) => fn({ query }));
    const request = { json: async () => ({ productId: "MLA1", lowStockThreshold: null }) } as any;

    await PATCH(request);

    expect(query).toHaveBeenCalledWith(expect.stringContaining("UPDATE products SET low_stock_threshold"), [
      null, "acc1", "MLA1",
    ]);
  });

  it("returns 400 for a negative or non-integer lowStockThreshold", async () => {
    const badRequest = { json: async () => ({ productId: "MLA1", lowStockThreshold: -1 }) } as any;
    expect((await PATCH(badRequest)).status).toBe(400);

    const floatRequest = { json: async () => ({ productId: "MLA1", lowStockThreshold: 2.5 }) } as any;
    expect((await PATCH(floatRequest)).status).toBe(400);
  });

  it("returns 503 instead of a silent no-op when migration 014 hasn't run", async () => {
    // El bug real: sin la columna, el UPDATE se saltaba entero y la ruta
    // igual contestaba {ok:true} — el vendedor creía que la alerta había
    // quedado guardada cuando en realidad no se tocó nada.
    const query = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("information_schema.columns")) {
        return { rows: [{ table_name: "products", column_name: "thumbnail" }] };
      }
      return { rows: [] };
    });
    vi.mocked(withScope).mockImplementation((ctx: any, fn: any) => fn({ query }));
    const request = { json: async () => ({ productId: "MLA1", lowStockThreshold: 5 }) } as any;

    const res = await PATCH(request);

    expect(res.status).toBe(503);
    expect(query).not.toHaveBeenCalledWith(expect.stringContaining("UPDATE products SET low_stock_threshold"), expect.anything());
  });

  it("still saves the cost when the threshold migration is missing, but flags the threshold as not saved", async () => {
    // Costo y umbral son independientes: si falta la migración 014, no
    // tiene por qué frenar el guardado del costo cuando se mandan juntos.
    const query = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("information_schema.columns")) {
        return {
          rows: [
            { table_name: "products", column_name: "thumbnail" },
            { table_name: "order_items", column_name: "iva_applied" },
          ],
        };
      }
      return { rows: [] };
    });
    vi.mocked(withScope).mockImplementation((ctx: any, fn: any) => fn({ query }));
    const request = { json: async () => ({ productId: "MLA1", cost: 350, lowStockThreshold: 5 }) } as any;

    const res = await PATCH(request);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, warning: expect.stringContaining("014-alerta-stock-bajo.sql") });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO product_costs"), expect.anything());
    expect(query).not.toHaveBeenCalledWith(expect.stringContaining("UPDATE products SET low_stock_threshold"), expect.anything());
  });

  it("ignores a per-product tax: taxes are an account-level rate now", async () => {
    const query = queryMock();
    vi.mocked(withScope).mockImplementation((ctx: any, fn: any) => fn({ query }));
    const request = { json: async () => ({ productId: "MLA1", cost: 350, tax: 40 }) } as any;

    await PATCH(request);

    const insert = query.mock.calls.find((c) => String(c[0]).includes("INSERT INTO product_costs"));
    expect(insert?.[0]).not.toContain("tax");
    expect(insert?.[1]).toEqual(["acc1", "MLA1", 350, expect.any(String)]);
  });

  it("returns 400 for an exchangeRate that isn't a positive number", async () => {
    const request = { json: async () => ({ productId: "MLA1", cost: 350, exchangeRate: -1 }) } as any;
    expect((await PATCH(request)).status).toBe(400);
  });

  it("guarda el tipo de cambio y la moneda usada junto con el costo, cuando la migración 019 ya corrió", async () => {
    const query = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("information_schema.columns")) {
        return {
          rows: [
            { table_name: "product_costs", column_name: "exchange_rate" },
            { table_name: "order_items", column_name: "iva_applied" },
          ],
        };
      }
      return { rows: [] };
    });
    vi.mocked(withScope).mockImplementation((ctx: any, fn: any) => fn({ query }));
    const request = { json: async () => ({ productId: "MLA1", cost: 5000, exchangeRate: 1450, costCurrency: "USD" }) } as any;

    await PATCH(request);

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO product_costs"),
      ["acc1", "MLA1", 5000, expect.any(String), 1450, "USD"]
    );
  });

  it("guarda cost_currency ARS por defecto y exchange_rate null cuando no se manda ninguno de los dos", async () => {
    const query = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("information_schema.columns")) {
        return { rows: [{ table_name: "product_costs", column_name: "exchange_rate" }] };
      }
      return { rows: [] };
    });
    vi.mocked(withScope).mockImplementation((ctx: any, fn: any) => fn({ query }));
    const request = { json: async () => ({ productId: "MLA1", cost: 350 }) } as any;

    await PATCH(request);

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO product_costs"),
      ["acc1", "MLA1", 350, expect.any(String), null, "ARS"]
    );
  });

  it("sigue guardando el costo sin tipo de cambio cuando la migración 019 no corrió", async () => {
    const query = queryMock();
    vi.mocked(withScope).mockImplementation((ctx: any, fn: any) => fn({ query }));
    const request = { json: async () => ({ productId: "MLA1", cost: 350, exchangeRate: 1450, costCurrency: "USD" }) } as any;

    await PATCH(request);

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO product_costs"),
      ["acc1", "MLA1", 350, expect.any(String)]
    );
  });
});

describe("GET /api/products", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetColumnCache();
    vi.mocked(resolveCurrentAccount).mockResolvedValue(account);
  });

  it("returns 401 when there is no active account", async () => {
    vi.mocked(resolveCurrentAccount).mockResolvedValue(null);
    const res = await GET({ nextUrl: new URL("http://x/api/products") } as any);
    expect(res.status).toBe(401);
  });

  it("marca negativeMargin cuando la ganancia real promedio por unidad vendida es negativa", async () => {
    const query = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("information_schema.columns")) return { rows: [] };
      return {
        rows: [
          // Vendió 4 unidades y en total perdió $200 (comisión + envío reales
          // superaron el precio) => -50 de ganancia real por unidad.
          { id: "MLA1", title: "Producto perdedor", sku: null, currentPrice: 1000, stock: 10, currentCost: 900, unitsSold: 4, totalProfit: -200 },
          // Ganó plata de verdad: no debe marcarse.
          { id: "MLA2", title: "Producto sano", sku: null, currentPrice: 1000, stock: 10, currentCost: 500, unitsSold: 4, totalProfit: 800 },
          // Sin ventas todavía: no hay señal real para juzgar, no se marca.
          { id: "MLA3", title: "Sin ventas", sku: null, currentPrice: 1000, stock: 10, currentCost: 500, unitsSold: 0, totalProfit: 0 },
        ],
      };
    });
    vi.mocked(withScope).mockImplementation((ctx: any, fn: any) => fn({ query }));

    const body = await (await GET({ nextUrl: new URL("http://x/api/products") } as any)).json();

    expect(body.find((p: any) => p.id === "MLA1")).toMatchObject({ avgProfitPerUnit: -50, negativeMargin: true });
    expect(body.find((p: any) => p.id === "MLA2")).toMatchObject({ avgProfitPerUnit: 200, negativeMargin: false });
    expect(body.find((p: any) => p.id === "MLA3")).toMatchObject({ avgProfitPerUnit: null, negativeMargin: false });
  });

  it("devuelve lastSaleDate como ISO, o null si nunca vendió — para poder ordenar por antigüedad de venta", async () => {
    const query = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("information_schema.columns")) return { rows: [] };
      return {
        rows: [
          { id: "MLA1", title: "Con ventas", sku: null, currentPrice: 1000, stock: 10, currentCost: 500, unitsSold: 3, totalProfit: 300, lastSaleDate: "2026-08-01T12:00:00.000Z" },
          { id: "MLA2", title: "Nunca vendió", sku: null, currentPrice: 1000, stock: 10, currentCost: 500, unitsSold: 0, totalProfit: 0, lastSaleDate: null },
        ],
      };
    });
    vi.mocked(withScope).mockImplementation((ctx: any, fn: any) => fn({ query }));

    const body = await (await GET({ nextUrl: new URL("http://x/api/products") } as any)).json();

    expect(body.find((p: any) => p.id === "MLA1").lastSaleDate).toBe("2026-08-01T12:00:00.000Z");
    expect(body.find((p: any) => p.id === "MLA2").lastSaleDate).toBeNull();
  });

  it("devuelve currentCostUsd usando el TC guardado junto al costo, o null si no hay TC guardado", async () => {
    const query = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("information_schema.columns")) {
        return { rows: [{ table_name: "product_costs", column_name: "exchange_rate" }] };
      }
      return {
        rows: [
          // Costo cargado en dólares: 5000 ARS con TC 1450 => ~3.45 USD.
          { id: "MLA1", title: "Con TC", sku: null, currentPrice: 1000, stock: 10, currentCost: 5000, currentCostExchangeRate: 1450, unitsSold: 0, totalProfit: 0 },
          // Costo viejo, cargado antes de la migración 019: sin TC, no hay con qué convertir.
          { id: "MLA2", title: "Sin TC", sku: null, currentPrice: 1000, stock: 10, currentCost: 500, currentCostExchangeRate: null, unitsSold: 0, totalProfit: 0 },
        ],
      };
    });
    vi.mocked(withScope).mockImplementation((ctx: any, fn: any) => fn({ query }));

    const body = await (await GET({ nextUrl: new URL("http://x/api/products") } as any)).json();

    expect(body.find((p: any) => p.id === "MLA1").currentCostUsd).toBeCloseTo(5000 / 1450);
    expect(body.find((p: any) => p.id === "MLA2").currentCostUsd).toBeNull();
  });
});

describe("DELETE /api/products", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetColumnCache();
    vi.mocked(resolveCurrentAccount).mockResolvedValue(account);
  });

  it("returns 401 when there is no active account", async () => {
    vi.mocked(resolveCurrentAccount).mockResolvedValue(null);
    const res = await DELETE({ nextUrl: new URL("http://x/api/products?productId=MLA1") } as any);
    expect(res.status).toBe(401);
  });

  it("returns 400 when productId is missing", async () => {
    const res = await DELETE({ nextUrl: new URL("http://x/api/products") } as any);
    expect(res.status).toBe(400);
  });

  it("borra TODO el historial de costos del producto y recalcula sus ventas", async () => {
    // El bug real que arregla: un costo cargado mal (ej. un cero de más) y
    // corregido después seguía afectando la ganancia de ventas viejas —
    // getCostEntryAtDate usa el PRIMER costo cargado como mejor estimación
    // cuando ninguno tiene fecha anterior a la venta, y ese primer costo
    // seguía siendo el erróneo. Borrar el historial entero deja que el
    // próximo costo cargado sea "el primero" de nuevo.
    const query = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("information_schema.columns")) {
        return { rows: [{ table_name: "order_items", column_name: "iva_applied" }] };
      }
      if (sql.includes("FROM product_costs")) {
        return { rows: [] }; // ya sin costos: se acaban de borrar
      }
      if (sql.includes("FROM order_items oi JOIN orders o")) {
        return {
          rows: [
            {
              id: 7, productid: "MLA1", quantity: 2, datecreated: "2026-02-01T00:00:00Z",
              unitprice: 1000, mlcommission: 130, shippingcost: 0, adscostallocated: 0,
            },
          ],
        };
      }
      return { rows: [] };
    });
    vi.mocked(withScope).mockImplementation((ctx: any, fn: any) => fn({ query }));

    const res = await DELETE({ nextUrl: new URL("http://x/api/products?productId=MLA1") } as any);

    expect(await res.json()).toEqual({ ok: true, itemsUpdated: 1 });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("DELETE FROM product_costs"),
      ["acc1", "MLA1"]
    );
    // Sin costos, la línea vuelve a "sin costo cargado" (cost_applied null).
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE order_items SET cost_applied"),
      expect.arrayContaining([null, 7])
    );
  });
});
