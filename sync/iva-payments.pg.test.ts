import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { nanoid } from "nanoid";

// Postgres real: lo que se prueba es la consulta que reparte el IVA cargado
// por mes entre las ventas, ajusta la ganancia por la diferencia y vuelve al
// cálculo teórico al borrar el monto.
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL || "postgres://app_user:app_user_local_test_pw@localhost:5432/ml_dashboard_test";

const THEORETICAL = (gross: number, charges: number, cost: number) => (gross - charges - cost) * (0.21 / 1.21);

describe("IVA pagado por mes (Postgres real)", () => {
  beforeAll(() => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
  });
  afterAll(async () => {
    const { closeDb } = await import("@/db/client");
    await closeDb();
  });

  it("reparte el IVA cargado según la facturación del mes, estima los meses sin cargar y vuelve al teórico al borrar", async () => {
    const { withScope } = await import("@/db/client");
    const { createAccount } = await import("@/db/accounts");
    const { applyIvaPayments, saveIvaPayment, listIvaMonths } = await import("./iva-payments");

    const account = await withScope({ isAdmin: true }, (c) => createAccount(c, "Cuenta IVA", `iva.${nanoid(6)}@example.com`.toLowerCase()));
    const other = await withScope({ isAdmin: true }, (c) => createAccount(c, "Otra", `otra.${nanoid(6)}@example.com`.toLowerCase()));

    const rows = await withScope({ accountId: account.id }, async (c) => {
      // Agosto: 60.000 + 40.000 (+ una cancelada que no cuenta). Septiembre: 50.000.
      const orders: [string, string, string][] = [
        ["A1", "2026-08-10T15:00:00Z", "paid"],
        ["A2", "2026-08-20T15:00:00Z", "paid"],
        ["AX", "2026-08-21T15:00:00Z", "cancelled"],
        // 31/8 a las 22 h de Argentina = 1/9 01 h UTC: es de agosto.
        ["A3", "2026-09-01T01:00:00Z", "paid"],
        ["S1", "2026-09-15T15:00:00Z", "paid"],
      ];
      for (const [id, date, status] of orders) {
        await c.query(`INSERT INTO orders (account_id, id, date_created, status) VALUES ($1, $2, $3, $4)`, [account.id, id, date, status]);
      }
      const items: [string, string, number, number, number, number][] = [
        // order, product, gross, commission+shipping, cost, (theoretical iva computed below)
        ["A1", "P1", 60000, 10000, 20000, 0],
        ["A2", "P2", 30000, 5000, 10000, 0],
        ["AX", "P2", 99999, 0, 0, 0],
        ["A3", "P2", 10000, 1000, 3000, 0],
        ["S1", "P1", 50000, 8000, 15000, 0],
      ];
      for (const [order, product, gross, charges, cost] of items) {
        const iva = THEORETICAL(gross, charges, cost);
        await c.query(
          `INSERT INTO order_items (account_id, order_id, product_id, unit_price, quantity, ml_commission, shipping_cost, ads_cost_allocated, cost_applied, tax_applied, iva_applied, net_profit)
           VALUES ($1, $2, $3, $4, 1, $5, 0, 0, $6, 0, $7, $8)`,
          [account.id, order, product, gross, charges, cost, iva, gross - charges - cost - iva]
        );
      }

      // Agosto: pagó 10.000 sobre 100.000 facturados → 10%.
      await saveIvaPayment(c, account.id, "2026-08", 10000);
      await applyIvaPayments(c, account.id, { force: true });
      const after = await c.query<{ order_id: string; iva_applied: number; net_profit: number; unit_price: number; ml_commission: number; cost_applied: number }>(
        `SELECT order_id, iva_applied, net_profit, unit_price, ml_commission, cost_applied FROM order_items WHERE account_id = $1 ORDER BY order_id`,
        [account.id]
      );
      const months = await listIvaMonths(c, account.id, 120);

      // Borrar el monto vuelve todo al cálculo teórico.
      await saveIvaPayment(c, account.id, "2026-08", null);
      await applyIvaPayments(c, account.id, { force: true });
      const restored = await c.query<{ order_id: string; iva_applied: number; net_profit: number }>(
        `SELECT order_id, iva_applied, net_profit FROM order_items WHERE account_id = $1 ORDER BY order_id`,
        [account.id]
      );
      return { after: after.rows, months, restored: restored.rows };
    });

    const by = Object.fromEntries(rows.after.map((r) => [r.order_id, r]));
    // Agosto al 10%: 6.000 + 3.000 + 1.000 = 10.000 exactos.
    expect(Number(by.A1.iva_applied)).toBeCloseTo(6000, 2);
    expect(Number(by.A2.iva_applied)).toBeCloseTo(3000, 2);
    expect(Number(by.A3.iva_applied)).toBeCloseTo(1000, 2);
    // La ganancia se ajusta por la diferencia de IVA.
    expect(Number(by.A1.net_profit)).toBeCloseTo(60000 - 10000 - 20000 - 6000, 2);
    // Septiembre no tiene monto: usa el 10% de agosto.
    expect(Number(by.S1.iva_applied)).toBeCloseTo(5000, 2);
    expect(Number(by.S1.net_profit)).toBeCloseTo(50000 - 8000 - 15000 - 5000, 2);
    // La cancelada no se toca.
    expect(Number(by.AX.iva_applied)).toBeCloseTo(THEORETICAL(99999, 0, 0), 2);

    const aug = rows.months.find((m) => m.period === "2026-08")!;
    expect(aug).toMatchObject({ revenue: 100000, paid: 10000 });
    expect(aug.effectiveRate).toBeCloseTo(0.1, 6);
    expect(aug.applied).toBeCloseTo(10000, 2);
    expect(rows.months.find((m) => m.period === "2026-09")).toMatchObject({ revenue: 50000, paid: null, effectiveRate: null });

    const restored = Object.fromEntries(rows.restored.map((r) => [r.order_id, r]));
    expect(Number(restored.A1.iva_applied)).toBeCloseTo(THEORETICAL(60000, 10000, 20000), 2);
    expect(Number(restored.S1.net_profit)).toBeCloseTo(50000 - 8000 - 15000 - THEORETICAL(50000, 8000, 15000), 2);

    // Otra cuenta no ve ni puede cargar montos de esta.
    const seen = await withScope({ accountId: other.id }, async (c) => {
      const r = await c.query(`SELECT * FROM iva_payments WHERE account_id = $1`, [account.id]);
      let blocked = false;
      try {
        await c.query(`INSERT INTO iva_payments (account_id, period, amount) VALUES ($1, '2026-07-01', 1)`, [account.id]);
      } catch {
        blocked = true;
      }
      return { rows: r.rows.length, blocked };
    });
    expect(seen).toEqual({ rows: 0, blocked: true });
  });

  it("una cuenta sin montos cargados no se toca", async () => {
    const { withScope } = await import("@/db/client");
    const { createAccount } = await import("@/db/accounts");
    const { applyIvaPayments } = await import("./iva-payments");
    const account = await withScope({ isAdmin: true }, (c) => createAccount(c, "Sin IVA", `sin.${nanoid(6)}@example.com`.toLowerCase()));
    const updated = await withScope({ accountId: account.id }, async (c) => {
      await c.query(`INSERT INTO orders (account_id, id, date_created, status) VALUES ($1, 'O1', '2026-08-10T15:00:00Z', 'paid')`, [account.id]);
      await c.query(
        `INSERT INTO order_items (account_id, order_id, product_id, unit_price, quantity, ml_commission, shipping_cost, cost_applied, iva_applied, net_profit)
         VALUES ($1, 'O1', 'P1', 1000, 1, 100, 0, 500, 12345, 1)`,
        [account.id]
      );
      return applyIvaPayments(c, account.id);
    });
    expect(updated).toBe(0);
  });

  it("cambiar un costo y recalcular el producto mantiene el IVA real cargado", async () => {
    const { withScope } = await import("@/db/client");
    const { createAccount } = await import("@/db/accounts");
    const { applyIvaPayments, saveIvaPayment } = await import("./iva-payments");
    const { recalculateProduct } = await import("./sync-service");
    const account = await withScope({ isAdmin: true }, (c) => createAccount(c, "Recalc", `recalc.${nanoid(6)}@example.com`.toLowerCase()));
    const row = await withScope({ accountId: account.id }, async (c) => {
      await c.query(`INSERT INTO orders (account_id, id, date_created, status) VALUES ($1, 'O1', '2026-08-10T15:00:00Z', 'paid')`, [account.id]);
      await c.query(
        `INSERT INTO order_items (account_id, order_id, product_id, unit_price, quantity, ml_commission, shipping_cost, ads_cost_allocated, cost_applied, tax_applied, iva_applied, net_profit)
         VALUES ($1, 'O1', 'P1', 20000, 1, 3000, 0, 0, 8000, 0, 0, 9000)`,
        [account.id]
      );
      await saveIvaPayment(c, account.id, "2026-08", 1000); // 5%
      await applyIvaPayments(c, account.id, { force: true });
      // Nuevo costo: 10.000. El recálculo escribe el IVA teórico y el hook lo reemplaza por el real.
      await c.query(`INSERT INTO product_costs (account_id, product_id, cost, valid_from) VALUES ($1, 'P1', 10000, now())`, [account.id]);
      await recalculateProduct(c, account.id, "P1", true, 0, true);
      return (await c.query<{ iva_applied: number; net_profit: number }>(`SELECT iva_applied, net_profit FROM order_items WHERE account_id = $1`, [account.id])).rows[0];
    });
    expect(Number(row.iva_applied)).toBeCloseTo(1000, 2);
    expect(Number(row.net_profit)).toBeCloseTo(20000 - 3000 - 10000 - 1000, 2);
  });
});
