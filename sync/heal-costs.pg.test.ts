import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { nanoid } from "nanoid";

// Postgres real, nada mockeado: lo que se prueba es la consulta SQL que
// detecta ventas con un costo viejo aplicado — con mocks no hay forma de
// saber si compara bien fechas, NULLs y el "primer costo" de respaldo.
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL || "postgres://app_user:app_user_local_test_pw@localhost:5432/ml_dashboard_test";

describe("healRecentCostEdits (Postgres real)", () => {
  beforeAll(() => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
  });

  afterAll(async () => {
    const { closeDb } = await import("@/db/client");
    await closeDb();
  });

  it("recalcula una venta que quedó con el costo viejo aunque ya se haya cargado el nuevo", async () => {
    const { withScope } = await import("@/db/client");
    const { createAccount } = await import("@/db/accounts");
    const { healRecentCostEdits } = await import("./sync-service");

    const account = await withScope({ isAdmin: true }, (client) =>
      createAccount(client, "Cuenta costos", `costos.${nanoid(6)}@example.com`)
    );

    const net = await withScope({ accountId: account.id }, async (client) => {
      await client.query(`INSERT INTO products (account_id, id, title, current_price, stock, updated_at) VALUES ($1, 'MLA1', 'Mochila', 12591, 3, now())`, [account.id]);
      await client.query(`INSERT INTO orders (account_id, id, date_created, status) VALUES ($1, 'O1', '2026-08-06T12:00:00Z', 'paid')`, [account.id]);
      // La venta quedó calculada con un costo erróneo de 9000 (lo que pasa
      // cuando una sincronización en paralelo pisa el recálculo)…
      await client.query(
        `INSERT INTO order_items (account_id, order_id, product_id, unit_price, quantity, ml_commission, shipping_cost, ads_cost_allocated, cost_applied, tax_applied, iva_applied, net_profit)
         VALUES ($1, 'O1', 'MLA1', 12591, 1, 3244.77, 0, 0, 9000, 0, 0, 346.23)`,
        [account.id]
      );
      // …pero el único costo cargado hoy es 3000 (el viejo se borró).
      await client.query(`INSERT INTO product_costs (account_id, product_id, cost, valid_from) VALUES ($1, 'MLA1', 3000, now())`, [account.id]);

      const healed = await healRecentCostEdits(client, account.id, true, 0, false);
      expect(healed).toEqual(["MLA1"]);

      // Segunda pasada: ya no queda nada desactualizado.
      expect(await healRecentCostEdits(client, account.id, true, 0, false)).toEqual([]);

      const row = await client.query(`SELECT cost_applied, net_profit FROM order_items WHERE account_id = $1`, [account.id]);
      return row.rows[0];
    });

    expect(Number(net.cost_applied)).toBe(3000);
    expect(Number(net.net_profit)).toBeCloseTo(12591 - 3244.77 - 3000, 2);
  });

  it("no toca productos sin costos editados recientemente", async () => {
    const { withScope } = await import("@/db/client");
    const { createAccount } = await import("@/db/accounts");
    const { healRecentCostEdits } = await import("./sync-service");

    const account = await withScope({ isAdmin: true }, (client) =>
      createAccount(client, "Cuenta vieja", `vieja.${nanoid(6)}@example.com`)
    );

    const healed = await withScope({ accountId: account.id }, async (client) => {
      await client.query(`INSERT INTO orders (account_id, id, date_created, status) VALUES ($1, 'O1', '2026-01-06T12:00:00Z', 'paid')`, [account.id]);
      await client.query(
        `INSERT INTO order_items (account_id, order_id, product_id, unit_price, quantity, ml_commission, shipping_cost, cost_applied, net_profit)
         VALUES ($1, 'O1', 'MLA2', 1000, 1, 100, 0, 500, 400)`,
        [account.id]
      );
      await client.query(
        `INSERT INTO product_costs (account_id, product_id, cost, valid_from) VALUES ($1, 'MLA2', 700, now() - interval '60 days')`,
        [account.id]
      );
      return healRecentCostEdits(client, account.id, true, 0, false);
    });

    expect(healed).toEqual([]);
  });

  it("pendingOrderIds solo vuelve a pedir órdenes viejas con alguna línea de más de una unidad", async () => {
    const { withScope } = await import("@/db/client");
    const { createAccount } = await import("@/db/accounts");
    const { pendingOrderIds } = await import("./sync-service");

    const account = await withScope({ isAdmin: true }, (client) =>
      createAccount(client, "Cuenta comisión", `comision.${nanoid(6)}@example.com`)
    );

    const pending = await withScope({ accountId: account.id }, async (client) => {
      for (const [id, qty] of [["UNA", 1], ["DOS", 2]] as const) {
        await client.query(`INSERT INTO orders (account_id, id, date_created, status, sync_version) VALUES ($1, $2, now(), 'paid', 1)`, [account.id, id]);
        await client.query(
          `INSERT INTO order_items (account_id, order_id, product_id, unit_price, quantity, ml_commission, shipping_cost) VALUES ($1, $2, 'MLA1', 100, $3, 13, 0)`,
          [account.id, id, qty]
        );
      }
      return pendingOrderIds(client, account.id, ["UNA", "DOS", "NUEVA"]);
    });

    expect(pending.sort()).toEqual(["DOS", "NUEVA"]);
  });
});

