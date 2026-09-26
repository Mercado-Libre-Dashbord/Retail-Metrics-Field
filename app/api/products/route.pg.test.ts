import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { nanoid } from "nanoid";

// Punta a punta contra Postgres real: estimación de cargos (sync), carga de
// costo (PATCH), recálculo, costo nuevo encima, borrado (DELETE) y lo que ve
// la pantalla de Productos (GET). Lo único simulado es Mercado Libre.
vi.mock("@/lib/current-account", () => ({ resolveCurrentAccount: vi.fn() }));
vi.mock("@/mcp/tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/mcp/tools")>();
  return {
    ...actual,
    getListingFee: vi.fn(async () => ({ saleFee: 13050, fixedFee: 0 })),
    getFreeShippingCost: vi.fn(async () => 12000),
  };
});

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL || "postgres://app_user:app_user_local_test_pw@localhost:5432/ml_dashboard_test";

describe("Productos: margen y beneficio de punta a punta (Postgres real)", () => {
  beforeAll(() => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
  });

  afterAll(async () => {
    const { closeDb } = await import("@/db/client");
    await closeDb();
  });

  it("producto sin ventas: margen estimado con comisión y envío; con ventas: real; costo nuevo y borrado se aplican a todo", async () => {
    const { withScope } = await import("@/db/client");
    const { createAccount } = await import("@/db/accounts");
    const { resolveCurrentAccount } = await import("@/lib/current-account");
    const { syncProductEstimates } = await import("@/sync/sync-service");
    const { GET, PATCH, DELETE } = await import("./route");

    const created = await withScope({ isAdmin: true }, (client) =>
      createAccount(client, "Cuenta margen", `margen.${nanoid(6)}@example.com`)
    );
    // Monotributo: sin IVA, para que las cuentas del test se lean fácil.
    const account = { ...created, otherTaxRate: 0, taxCondition: "monotributo" as const };
    vi.mocked(resolveCurrentAccount).mockResolvedValue(account as any);

    await withScope({ accountId: account.id }, async (client) => {
      await client.query(
        `INSERT INTO products (account_id, id, title, current_price, stock, updated_at, category_id, listing_type_id, free_shipping)
         VALUES ($1,'REFLECTOR','Reflector Solar',87000,11,now(),'MLA1','gold_special',true),
                ($1,'BANDEJA','Bandeja',5841,5,now(),'MLA2','gold_special',false)`,
        [account.id]
      );
      await client.query(`INSERT INTO orders (account_id, id, date_created, status) VALUES ($1,'O1','2026-09-01','paid')`, [account.id]);
      await client.query(
        `INSERT INTO order_items (account_id, order_id, product_id, unit_price, quantity, ml_commission, shipping_cost, ads_cost_allocated)
         VALUES ($1,'O1','BANDEJA',5841,1,2186,0,600)`,
        [account.id]
      );
    });

    // 1) El sync estima cargos para los productos.
    const est = await withScope({ accountId: account.id }, (client) => syncProductEstimates(client, account.id, "S1", Date.now() + 10_000));
    expect(est).toEqual({ updated: 2, done: true });

    const list = async () => {
      const res = await GET({ nextUrl: new URL("http://x/api/products") } as any);
      const body = await res.json();
      return Object.fromEntries(body.map((p: any) => [p.id, p]));
    };
    const patch = (productId: string, cost: number) =>
      PATCH({ json: async () => ({ productId, cost }) } as any);

    // 2) Carga de costo en un producto sin ventas: margen estimado, no 74%.
    await patch("REFLECTOR", 22620);
    let p = await list();
    expect(p.REFLECTOR.margin.kind).toBe("estimado");
    expect(p.REFLECTOR.margin.perUnit.net).toBe(87000 - 13050 - 12000 - 22620);
    expect(p.REFLECTOR.marginPct).toBeCloseTo((87000 - 13050 - 12000 - 22620) / 87000);

    // 3) Producto con venta: al cargar el costo se recalcula el beneficio y el margen es real.
    await patch("BANDEJA", 9999);
    p = await list();
    expect(p.BANDEJA.totalProfit).toBeCloseTo(5841 - 2186 - 600 - 9999);
    expect(p.BANDEJA.margin.kind).toBe("real");

    // 4) Costo corregido ENCIMA (sin borrar): se aplica a la venta vieja también.
    await patch("BANDEJA", 3565);
    p = await list();
    expect(p.BANDEJA.currentCost).toBe(3565);
    expect(p.BANDEJA.totalProfit).toBeCloseTo(5841 - 2186 - 600 - 3565);
    expect(p.BANDEJA.margin.pct).toBeCloseTo((5841 - 2186 - 600 - 3565) / 5841);

    // 5) Borrar el costo: la venta queda sin costo (fuera de la ganancia) y el margen desaparece.
    await DELETE({ nextUrl: new URL("http://x/api/products?productId=BANDEJA") } as any);
    p = await list();
    expect(p.BANDEJA.currentCost).toBeNull();
    expect(p.BANDEJA.totalProfit).toBe(0);
    expect(p.BANDEJA.margin).toBeNull();

    // 6) Volver a cargarlo: se recalcula de nuevo.
    await patch("BANDEJA", 3000);
    p = await list();
    expect(p.BANDEJA.totalProfit).toBeCloseTo(5841 - 2186 - 600 - 3000);
  });
});
