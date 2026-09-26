import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { nanoid } from "nanoid";

// Postgres real: la consulta arma gasto, ventas y ganancia con CTEs y joins;
// con mocks no hay forma de saber si el SQL corre.
vi.mock("@/lib/current-account", () => ({ resolveCurrentAccount: vi.fn() }));

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL || "postgres://app_user:app_user_local_test_pw@localhost:5432/ml_dashboard_test";

describe("GET /api/campaigns/products (Postgres real)", () => {
  beforeAll(() => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
  });

  afterAll(async () => {
    const { closeDb } = await import("@/db/client");
    await closeDb();
  });

  it("usa el gasto real de cada publicación e incluye las que gastan sin vender", async () => {
    const { withScope } = await import("@/db/client");
    const { createAccount } = await import("@/db/accounts");
    const { resolveCurrentAccount } = await import("@/lib/current-account");
    const { GET } = await import("./route");

    const account = await withScope({ isAdmin: true }, (client) =>
      createAccount(client, "Cuenta campañas", `camp.${nanoid(6)}@example.com`)
    );
    vi.mocked(resolveCurrentAccount).mockResolvedValue(account as any);

    await withScope({ accountId: account.id }, async (client) => {
      await client.query(`INSERT INTO orders (account_id, id, date_created, status) VALUES ($1,'O1','2026-03-05','paid'), ($1,'O0','2026-01-05','paid')`, [account.id]);
      // Venta dentro del rango con Ads: 1000 de venta, 600 de ganancia ya con 100 de Ads repartidos.
      await client.query(
        `INSERT INTO order_items (account_id, order_id, product_id, unit_price, quantity, ml_commission, shipping_cost, ads_cost_allocated, cost_applied, net_profit)
         VALUES ($1,'O1','VENDE',1000,1,100,0,100,200,600), ($1,'O0','VENDE',1000,1,100,0,0,200,700)`,
        [account.id]
      );
      await client.query(
        `INSERT INTO ads_spend (account_id, product_id, date, amount, channel)
         VALUES ($1,'VENDE','2026-03-01',150,'mercado_ads'), ($1,'VENDE','2026-03-10',150,'mercado_ads'),
                ($1,'NO_VENDE','2026-03-02',80,'mercado_ads'), ($1,NULL,'2026-03-02',999,'mercado_ads')`,
        [account.id]
      );
    });

    const res = await GET({ nextUrl: { searchParams: new URLSearchParams("from=2026-01-01&to=2026-03-31") } } as any);
    const body = await res.json();

    expect(body.map((r: any) => r.productId)).toEqual(["VENDE", "NO_VENDE"]);
    // Solo la venta desde el primer día con Ads (5/3), no la de enero.
    expect(body[0]).toMatchObject({ revenue: 1000, adSpend: 300, netProfit: 700 - 300, missingCost: false });
    expect(body[1]).toMatchObject({ revenue: 0, adSpend: 80, netProfit: -80, recommendation: "pausar" });
  });
});
