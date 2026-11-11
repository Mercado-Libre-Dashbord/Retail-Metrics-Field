import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { nanoid } from "nanoid";

// Postgres real: qué se resta de la ganancia del período además de las
// ventas, y qué NO (para no restar dos veces lo mismo).
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL || "postgres://app_user:app_user_local_test_pw@localhost:5432/ml_dashboard_test";

const IVA = (x: number) => x * (0.21 / 1.21);

describe("ajustes del período (Postgres real)", () => {
  beforeAll(() => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
  });
  afterAll(async () => {
    const { closeDb } = await import("@/db/client");
    await closeDb();
  });

  it("resta publicidad sin repartir, Full y otros cargos sin venta; no resta comisión, envío, percepciones ni lo atado a una orden", async () => {
    const { withScope } = await import("@/db/client");
    const { createAccount } = await import("@/db/accounts");
    const { monthlyAdjustments, periodAdjustments, chargeDetails } = await import("./period-charges");

    const account = await withScope({ isAdmin: true }, (c) => createAccount(c, "Cuenta ajustes", `aj.${nanoid(6)}@example.com`.toLowerCase()));

    const result = await withScope({ accountId: account.id }, async (c) => {
      const orders: [string, string, string][] = [
        ["O1", "2026-09-10T15:00:00Z", "paid"],
        ["O2", "2026-09-11T15:00:00Z", "cancelled"],
        ["O3", "2026-10-05T15:00:00Z", "paid"],
      ];
      for (const [id, date, status] of orders) {
        await c.query(`INSERT INTO orders (account_id, id, date_created, status) VALUES ($1, $2, $3, $4)`, [account.id, id, date, status]);
      }
      // Septiembre: 800 de Mercado Ads repartidos en la venta válida; la
      // cancelada tiene 200 asignados que no cuentan.
      const items: [string, number, number][] = [["O1", 800, 5000], ["O2", 200, 0], ["O3", 100, 1000]];
      for (const [order, ads, net] of items) {
        await c.query(
          `INSERT INTO order_items (account_id, order_id, product_id, unit_price, quantity, ml_commission, shipping_cost, ads_cost_allocated, cost_applied, tax_applied, net_profit)
           VALUES ($1, $2, 'P1', 10000, 1, 0, 0, $3, 1, 0, $4)`,
          [account.id, order, ads, net]
        );
      }
      await c.query(
        `INSERT INTO ads_spend (account_id, product_id, date, amount, channel) VALUES
           ($1, NULL, '2026-09-10', 1000, 'mercado_ads'),
           ($1, NULL, '2026-09-20', 500, 'meta'),
           ($1, NULL, '2026-10-05', 100, 'mercado_ads')`,
        [account.id]
      );
      const charges: [string, string, string | null, string | null, string | null, number, string | null][] = [
        // id, period, detail_type, sub_type, concept, amount, order
        ["c1", "2026-09-01", "CHARGE", "CV", "Cargo por venta", 1500, "O1"],
        ["c2", "2026-09-01", "CHARGE", null, "Costo de envío", 900, "O1"],
        ["c3", "2026-09-01", "CHARGE", null, "Percepción IIBB", 300, null],
        ["c4", "2026-09-01", "CHARGE", null, "Product Ads", 1000, null],
        ["c5", "2026-09-01", "CHARGE", null, "Cargo por almacenamiento Full", 2420, null],
        ["c6", "2026-09-01", "CHARGE", null, "Cargo varios", 700, "O1"],
        ["manual-1", "2026-09-01", "MANUAL", "manual:otro", null, 6094850, null],
        ["manual-2", "2026-10-01", "MANUAL", "manual:comision", null, 999, null],
      ];
      for (const [id, period, type, sub, concept, amount, order] of charges) {
        await c.query(
          `INSERT INTO billing_charges (account_id, detail_id, period_key, detail_type, detail_sub_type, concept, order_id, amount, charged_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [account.id, id, period, type, sub, concept, order, amount, id === "manual-1" ? "2026-09-30T12:00:00Z" : `${period.slice(0, 8)}15T12:00:00Z`]
        );
      }
      // Octubre tiene IVA real cargado: ahí no se suma crédito.
      await c.query(`INSERT INTO iva_payments (account_id, period, amount) VALUES ($1, '2026-10-01', 100)`, [account.id]);

      return {
        months: await monthlyAdjustments(c, account.id, "2026-09-01", "2026-10-31", true),
        sept: await periodAdjustments(c, account.id, "2026-09-01", "2026-09-30", true),
        monotributo: await periodAdjustments(c, account.id, "2026-09-01", "2026-09-30", false),
        details: await chargeDetails(c, account.id, "2026-09-01", "2026-09-30"),
      };
    });

    const { sept } = result;
    // Publicidad: 1500 gastados (1000 ML + 500 Meta) − 800 ya en la venta válida.
    expect(sept.adSpend).toBe(1500);
    expect(sept.adsInSales).toBe(800);
    expect(sept.adsNotInSales).toBe(700);
    // Full sin venta y lo cargado a mano se restan; comisión, envío,
    // percepciones, Product Ads y el "cargo varios" atado a O1, no.
    expect(sept.full).toBe(2420);
    expect(sept.otherCharges).toBe(6094850);
    // Factura vs. estimado: la venta O1 se guardó con comisión y envío en 0 y
    // la factura le ató 1500 + 900 + 700 (el "cargo varios" también es de la
    // venta): esos 3100 se restan. Percepciones y Product Ads no entran.
    expect(sept.ordersTotal).toBe(1);
    expect(sept.ordersInvoiced).toBe(1);
    expect(sept.invoiceBilled).toBe(3100);
    expect(sept.invoiceEstimated).toBe(0);
    expect(sept.invoiceDiff).toBe(3100);
    // Crédito de IVA: Mercado Ads sin repartir (200) + Full + otros + la diferencia con la factura. Meta no.
    expect(sept.ivaCredit).toBeCloseTo(IVA(200 + 2420 + 6094850 + 3100), 6);
    expect(sept.total).toBeCloseTo(-700 - 2420 - 6094850 - 3100 + IVA(200 + 2420 + 6094850 + 3100), 6);

    // Sin IVA discriminado no hay crédito.
    expect(result.monotributo.ivaCredit).toBe(0);
    expect(result.monotributo.total).toBe(-700 - 2420 - 6094850 - 3100);

    // Octubre: IVA real cargado, todo repartido, y la comisión cargada a mano no se resta.
    const oct = result.months.find((m) => m.month === "2026-10")!;
    // O3 todavía no tiene factura: sigue con lo estimado, sin ajuste.
    expect(oct).toMatchObject({ adSpend: 100, adsInSales: 100, adsNotInSales: 0, full: 0, otherCharges: 0, ordersTotal: 1, ordersInvoiced: 0, invoiceDiff: 0, ivaCredit: 0, total: 0 });

    const treatment = Object.fromEntries(result.details.map((d) => [d.concept, d.treatment]));
    expect(treatment).toMatchObject({
      "Cargo por venta": "per_sale",
      "Costo de envío": "per_sale",
      "Percepción IIBB": "tax",
      "Product Ads": "in_ads",
      "Cargo por almacenamiento Full": "subtracted",
      "Cargo varios": "per_sale",
      "Cargado a mano": "subtracted",
    });
  });
  it("concilia cada venta facturada con la factura: resta lo que ML cobró de más y devuelve lo estimado de más", async () => {
    const { withScope } = await import("@/db/client");
    const { createAccount } = await import("@/db/accounts");
    const { periodAdjustments } = await import("./period-charges");
    const account = await withScope({ isAdmin: true }, (c) => createAccount(c, "Cuenta factura", `fa.${nanoid(6)}@example.com`.toLowerCase()));

    const adj = await withScope({ accountId: account.id }, async (c) => {
      const orders: [string, string][] = [["A", "paid"], ["B", "paid"], ["C", "paid"], ["D", "cancelled"], ["E", "paid"]];
      for (const [id, status] of orders) {
        await c.query(`INSERT INTO orders (account_id, id, date_created, status) VALUES ($1, $2, '2026-09-10T15:00:00Z', $3)`, [account.id, id, status]);
      }
      // orden, comisión estimada, envío estimado, ganancia (null = sin costo cargado)
      const items: [string, number, number, number | null][] = [
        ["A", 1000, 500, 3000],   // ML cobró más: 1100 + 800 + 400 de cuotas
        ["B", 2000, 600, 4000],   // ML cobró menos: 1800 + 600, y bonificó 300
        ["C", 900, 300, 2000],    // sin factura todavía
        ["D", 700, 200, 0],       // cancelada: no cuenta
        ["E", 500, 100, null],    // sin costo cargado: fuera de la ganancia
      ];
      for (const [order, commission, shipping, net] of items) {
        await c.query(
          `INSERT INTO order_items (account_id, order_id, product_id, unit_price, quantity, ml_commission, shipping_cost, ads_cost_allocated, cost_applied, tax_applied, net_profit)
           VALUES ($1, $2, 'P1', 10000, 1, $3, $4, 0, $5, 0, $6)`,
          [account.id, order, commission, shipping, net === null ? null : 1, net]
        );
      }
      const charges: [string, string, string, number, string][] = [
        ["a1", "CHARGE", "Cargo por venta", 1100, "A"],
        ["a2", "CHARGE", "Costo de envío", 800, "A"],
        ["a3", "CHARGE", "Costo por ofrecer cuotas", 400, "A"],
        ["a4", "CHARGE", "Percepción IIBB", 250, "A"],   // impuesto: no entra
        ["a5", "CHARGE", "Product Ads", 90, "A"],        // publicidad: no entra
        ["b1", "CHARGE", "Cargo por venta", 1800, "B"],
        ["b2", "CHARGE", "Costo de envío", 600, "B"],
        ["b3", "BONUS", "Bonificación por envío", 300, "B"], // bonificación: descuenta
        ["d1", "CHARGE", "Cargo por venta", 700, "D"],
        ["e1", "CHARGE", "Cargo por venta", 900, "E"],
      ];
      for (const [id, type, concept, amount, order] of charges) {
        await c.query(
          `INSERT INTO billing_charges (account_id, detail_id, period_key, detail_type, detail_sub_type, concept, order_id, amount, charged_at)
           VALUES ($1, $2, '2026-09-01', $3, NULL, $4, $5, $6, '2026-09-15T12:00:00Z')`,
          [account.id, id, type, concept, order, amount]
        );
      }
      return periodAdjustments(c, account.id, "2026-09-01", "2026-09-30", false);
    });

    // Cuentan A, B y C (con costo y válidas); con factura, A y B.
    expect(adj.ordersTotal).toBe(3);
    expect(adj.ordersInvoiced).toBe(2);
    // Estimado en A y B: 1500 + 2600. Facturado: 2300 + (1800 + 600 − 300).
    expect(adj.invoiceEstimated).toBe(4100);
    expect(adj.invoiceBilled).toBe(4400);
    expect(adj.invoiceDiff).toBe(300);
    expect(adj.total).toBe(-300);
  });
});
