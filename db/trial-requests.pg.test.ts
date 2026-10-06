import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { nanoid } from "nanoid";

// Postgres real: lo que se prueba es RLS. El formulario es público, así que
// la base tiene que dejar insertar a cualquiera y leer solo a un admin.
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL || "postgres://app_user:app_user_local_test_pw@localhost:5432/ml_dashboard_test";

const input = (email: string) => ({
  name: "Laura", email, store: "Tienda", monthlySales: "50 a 200", phone: null,
  utmSource: "mail", utmMedium: null, utmCampaign: "ola1", utmContent: "hookA", referrer: null,
});

describe("trial_requests (Postgres real)", () => {
  beforeAll(() => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
  });
  afterAll(async () => {
    const { closeDb } = await import("@/db/client");
    await closeDb();
  });

  it("cualquiera inserta, nadie sin admin lee ni modifica, y un email repetido no se duplica", async () => {
    const { withScope } = await import("@/db/client");
    const { insertTrialRequest, listTrialRequests, setTrialRequestStatus } = await import("./trial-requests");
    const email = `lead.${nanoid(6)}@example.com`.toLowerCase();

    await withScope({}, (c) => insertTrialRequest(c, input(email)));
    await withScope({}, (c) => insertTrialRequest(c, input(email.toUpperCase())));

    // Sin sesión y con un cliente común: no ve nada.
    expect(await withScope({}, (c) => listTrialRequests(c))).toEqual([]);
    const asClient = await withScope({ userEmail: "cliente@example.com" }, (c) => listTrialRequests(c));
    expect(asClient).toEqual([]);

    const asAdmin = await withScope({ isAdmin: true }, (c) => listTrialRequests(c));
    const mine = asAdmin.filter((r) => r.email.toLowerCase() === email);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ status: "nueva", utmCampaign: "ola1", utmContent: "hookA" });

    // Un cliente común no puede cambiar el estado; un admin sí.
    expect(await withScope({ userEmail: "cliente@example.com" }, (c) => setTrialRequestStatus(c, mine[0].id, "descartada"))).toBe(false);
    expect(await withScope({ isAdmin: true }, (c) => setTrialRequestStatus(c, mine[0].id, "contactada"))).toBe(true);
  });
});
