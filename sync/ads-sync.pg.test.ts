import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { nanoid } from "nanoid";

// Postgres real para el INSERT por tandas con unnest(); lo único simulado es
// la respuesta de Mercado Ads.
vi.mock("@/mcp/tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/mcp/tools")>();
  return { ...actual, getAdsSpend: vi.fn() };
});

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL || "postgres://app_user:app_user_local_test_pw@localhost:5432/ml_dashboard_test";

describe("syncAds (Postgres real)", () => {
  beforeAll(() => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
  });

  afterAll(async () => {
    const { closeDb } = await import("@/db/client");
    await closeDb();
  });

  it("guarda miles de filas por publicación y día en pocas escrituras, sin tocar la publicidad cargada a mano", async () => {
    const { withScope } = await import("@/db/client");
    const { createAccount } = await import("@/db/accounts");
    const { syncAds } = await import("./sync-service");
    const { getAdsSpend } = await import("@/mcp/tools");

    const today = new Date();
    const day = (n: number) => new Date(today.getTime() - n * 86400000).toISOString().slice(0, 10);
    // 150 publicaciones × 80 días = 12.000 filas (más de dos tandas de 5.000).
    const rows = [];
    for (let p = 0; p < 150; p++) for (let d = 1; d <= 80; d++) rows.push({ productId: `MLA${p}`, date: day(d), amount: 1.5 });
    vi.mocked(getAdsSpend).mockResolvedValue(rows);

    const account = await withScope({ isAdmin: true }, (client) =>
      createAccount(client, "Cuenta ads", `ads.${nanoid(6)}@example.com`)
    );

    const result = await withScope({ accountId: account.id }, async (client) => {
      await client.query(`INSERT INTO ads_spend (account_id, product_id, date, amount, channel) VALUES ($1, NULL, $2, 999, 'meta')`, [account.id, day(3)]);
      const t0 = Date.now();
      const saved = await syncAds(client, account.id, "S1", `${day(85)}T00:00:00Z`);
      const ms = Date.now() - t0;
      const stored = await client.query<{ channel: string; n: string; total: string }>(
        `SELECT channel, COUNT(*) as n, SUM(amount) as total FROM ads_spend WHERE account_id = $1 GROUP BY channel ORDER BY channel`,
        [account.id]
      );
      return { saved, ms, stored: stored.rows };
    });

    expect(result.saved).toBe(12_000);
    expect(result.stored.map((r) => ({ channel: r.channel, n: Number(r.n), total: Number(r.total) }))).toEqual([
      { channel: "mercado_ads", n: 12000, total: 18000 },
      { channel: "meta", n: 1, total: 999 },
    ]);
    // Referencia local: con una escritura por fila esto tardaba varios segundos.
    expect(result.ms).toBeLessThan(5_000);
  });
});
