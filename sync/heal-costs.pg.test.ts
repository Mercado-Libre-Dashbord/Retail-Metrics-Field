import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { nanoid } from "nanoid";

// Postgres real, nada mockeado: lo que se prueba es la consulta SQL que
// detecta ventas con un costo viejo aplicado — con mocks no hay forma de
// saber si compara bien fechas, NULLs y el "primer costo" de respaldo.
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL || "postgres://app_user:app_user_local_test_pw@localhost:5432/ml_dashboard_test";

describe("healStaleCosts (Postgres real)", () => {
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
    const { healStaleCosts } = await import("./sync-service");

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

      const healed = await healStaleCosts(client, account.id, true, 0, false);
      expect(healed).toEqual(["MLA1"]);

      // Segunda pasada: ya no queda nada desactualizado.
      expect(await healStaleCosts(client, account.id, true, 0, false)).toEqual([]);

      const row = await client.query(`SELECT cost_applied, net_profit FROM order_items WHERE account_id = $1`, [account.id]);
      return row.rows[0];
    });

    expect(Number(net.cost_applied)).toBe(3000);
    expect(Number(net.net_profit)).toBeCloseTo(12591 - 3244.77 - 3000, 2);
  });

  it("también corrige costos viejos, ventas de productos sin costo, y no toca lo que está al día", async () => {
    const { withScope } = await import("@/db/client");
    const { createAccount } = await import("@/db/accounts");
    const { healStaleCosts } = await import("./sync-service");

    const account = await withScope({ isAdmin: true }, (client) =>
      createAccount(client, "Cuenta vieja", `vieja.${nanoid(6)}@example.com`)
    );

    const result = await withScope({ accountId: account.id }, async (client) => {
      const sale = async (order: string, product: string, applied: number | null) => {
        await client.query(`INSERT INTO orders (account_id, id, date_created, status) VALUES ($1, $2, '2026-01-06T12:00:00Z', 'paid')`, [account.id, order]);
        await client.query(
          `INSERT INTO order_items (account_id, order_id, product_id, unit_price, quantity, ml_commission, shipping_cost, cost_applied, net_profit)
           VALUES ($1, $2, $3, 1000, 1, 100, 0, $4, $5)`,
          [account.id, order, product, applied, applied === null ? null : 900 - applied]
        );
      };
      // Costo viejo (cargado hace 60 días) que la venta nunca tomó.
      await sale("O1", "VIEJO", 500);
      await client.query(`INSERT INTO product_costs (account_id, product_id, cost, valid_from) VALUES ($1, 'VIEJO', 700, now() - interval '60 days')`, [account.id]);
      // Costo corregido: el primero (erróneo) y el nuevo; tiene que ganar el nuevo para TODA venta.
      await sale("O2", "CORREGIDO", 9000);
      await client.query(`INSERT INTO product_costs (account_id, product_id, cost, valid_from) VALUES ($1, 'CORREGIDO', 9000, '2026-01-01'), ($1, 'CORREGIDO', 300, now())`, [account.id]);
      // Costo borrado: la venta tenía costo y ya no tiene que tenerlo.
      await sale("O3", "BORRADO", 400);
      // Al día: no se toca.
      await sale("O4", "OK", 250);
      await client.query(`INSERT INTO product_costs (account_id, product_id, cost, valid_from) VALUES ($1, 'OK', 250, now() - interval '90 days')`, [account.id]);
      // Sin costo nunca: tampoco.
      await sale("O5", "NUNCA", null);

      const healed = (await healStaleCosts(client, account.id, true, 0, false)).sort();
      const rows = await client.query<{ product_id: string; cost_applied: number | null; net_profit: number | null }>(
        `SELECT product_id, cost_applied, net_profit FROM order_items WHERE account_id = $1 ORDER BY product_id`,
        [account.id]
      );
      return { healed, rows: rows.rows };
    });

    expect(result.healed).toEqual(["BORRADO", "CORREGIDO", "VIEJO"]);
    const byId = Object.fromEntries(result.rows.map((r) => [r.product_id, r]));
    expect(Number(byId.VIEJO.cost_applied)).toBe(700);
    expect(Number(byId.CORREGIDO.cost_applied)).toBe(300);
    expect(Number(byId.CORREGIDO.net_profit)).toBe(1000 - 100 - 300);
    expect(byId.BORRADO.cost_applied).toBeNull();
    expect(byId.BORRADO.net_profit).toBeNull();
    expect(Number(byId.OK.cost_applied)).toBe(250);
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

  it("pendingOrderIds vuelve a pedir las órdenes con envío cargado para corregir envíos inexistentes o duplicados", async () => {
    const { withScope } = await import("@/db/client");
    const { createAccount } = await import("@/db/accounts");
    const { pendingOrderIds } = await import("./sync-service");

    const account = await withScope({ isAdmin: true }, (client) =>
      createAccount(client, "Cuenta envío", `envio.${nanoid(6)}@example.com`)
    );

    const pending = await withScope({ accountId: account.id }, async (client) => {
      for (const [id, shipping] of [["SIN_ENVIO", 0], ["CON_ENVIO", 8250]] as const) {
        await client.query(`INSERT INTO orders (account_id, id, date_created, status, sync_version) VALUES ($1, $2, now(), 'paid', 2)`, [account.id, id]);
        await client.query(
          `INSERT INTO order_items (account_id, order_id, product_id, unit_price, quantity, ml_commission, shipping_cost) VALUES ($1, $2, 'MLA1', 12591, 1, 3244, $3)`,
          [account.id, id, shipping]
        );
      }
      return pendingOrderIds(client, account.id, ["SIN_ENVIO", "CON_ENVIO"]);
    });

    expect(pending).toEqual(["CON_ENVIO"]);
  });
});

