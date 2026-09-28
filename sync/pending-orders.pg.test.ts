import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { nanoid } from "nanoid";

// Postgres real: qué órdenes vuelve a pedir el sync después de revertir la
// lógica de comisión y envío del 26–28/9 (versiones 2 y 3).
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL || "postgres://app_user:app_user_local_test_pw@localhost:5432/ml_dashboard_test";

describe("pendingOrderIds tras la reversión (Postgres real)", () => {
  beforeAll(() => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
  });

  afterAll(async () => {
    const { closeDb } = await import("@/db/client");
    await closeDb();
  });

  it("vuelve a pedir las órdenes de las versiones 2 y 3 y las nuevas; no las que nunca pasaron por esa lógica", async () => {
    const { withScope } = await import("@/db/client");
    const { createAccount } = await import("@/db/accounts");
    const { pendingOrderIds } = await import("./sync-service");

    const account = await withScope({ isAdmin: true }, (client) =>
      createAccount(client, "Cuenta reversión", `rev.${nanoid(6)}@example.com`)
    );

    const pending = await withScope({ accountId: account.id }, async (client) => {
      for (const [id, version] of [["V0", 0], ["V1", 1], ["V2", 2], ["V3", 3], ["V4", 4]] as const) {
        await client.query(`INSERT INTO orders (account_id, id, date_created, status, sync_version) VALUES ($1, $2, now(), 'paid', $3)`, [account.id, id, version]);
      }
      return pendingOrderIds(client, account.id, ["V0", "V1", "V2", "V3", "V4", "NUEVA"]);
    });

    expect(pending.sort()).toEqual(["NUEVA", "V0", "V2", "V3"]);
  });
});
