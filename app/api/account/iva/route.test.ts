import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/db/client", () => ({ withScope: vi.fn() }));
vi.mock("@/lib/current-account", () => ({ resolveCurrentAccount: vi.fn() }));
vi.mock("@/sync/iva-payments", () => ({
  applyIvaPayments: vi.fn(),
  ivaPaymentsAvailable: vi.fn(),
  listIvaMonths: vi.fn(),
  saveIvaPayment: vi.fn(),
}));

import { GET, PUT } from "./route";
import { withScope } from "@/db/client";
import { resolveCurrentAccount } from "@/lib/current-account";
import { applyIvaPayments, ivaPaymentsAvailable, listIvaMonths, saveIvaPayment } from "@/sync/iva-payments";

const req = (body: unknown) => ({ json: async () => body }) as any;
const account = (taxCondition: string) => ({
  id: "acc1", name: "Cuenta", ownerEmail: "a@example.com", mlSellerId: "S1", otherTaxRate: 0,
  taxCondition, taxConditionConfirmed: true, createdAt: "2026-01-01",
}) as any;

describe("/api/account/iva", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(withScope).mockImplementation((ctx: any, fn: any) => fn({}));
    vi.mocked(ivaPaymentsAvailable).mockResolvedValue(true);
    vi.mocked(listIvaMonths).mockResolvedValue([
      { period: "2026-08", revenue: 1_000_000, paid: null, effectiveRate: null, applied: 0 },
    ]);
  });

  it("exige una cuenta", async () => {
    vi.mocked(resolveCurrentAccount).mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
    expect((await PUT(req({ period: "2026-08", amount: 1 }))).status).toBe(401);
  });

  it("cualquier régimen puede cargar el IVA pagado: Exento y Monotributo también", async () => {
    vi.mocked(applyIvaPayments).mockResolvedValue(3);
    for (const taxCondition of ["exento", "monotributo"]) {
      vi.mocked(resolveCurrentAccount).mockResolvedValue(account(taxCondition));
      const res = await PUT(req({ period: "2026-08", amount: 1000 }));
      expect(res.status).toBe(200);
      // Para ellos los meses sin cargar no se estiman: appliesIva = false.
      expect(applyIvaPayments).toHaveBeenLastCalledWith({}, "acc1", false, { force: true });
    }
    expect(saveIvaPayment).toHaveBeenCalledTimes(2);
  });

  it("valida mes y monto", async () => {
    vi.mocked(resolveCurrentAccount).mockResolvedValue(account("responsable_inscripto"));
    expect((await PUT(req({ period: "2026-13", amount: 1 }))).status).toBe(400);
    expect((await PUT(req({ period: "agosto", amount: 1 }))).status).toBe(400);
    expect((await PUT(req({ period: "2026-08", amount: -5 }))).status).toBe(400);
    expect((await PUT(req({ period: "2026-08", amount: "1000" }))).status).toBe(400);
    expect(saveIvaPayment).not.toHaveBeenCalled();
  });

  it("guarda el monto con el scope de la cuenta y recalcula todo", async () => {
    vi.mocked(resolveCurrentAccount).mockResolvedValue(account("responsable_inscripto"));
    vi.mocked(applyIvaPayments).mockResolvedValue(12);
    const res = await PUT(req({ period: "2026-08", amount: 150000 }));
    expect(res.status).toBe(200);
    expect(vi.mocked(withScope).mock.calls[0][0]).toEqual({ accountId: "acc1" });
    expect(saveIvaPayment).toHaveBeenCalledWith({}, "acc1", "2026-08", 150000);
    expect(applyIvaPayments).toHaveBeenCalledWith({}, "acc1", true, { force: true });
    expect((await res.json()).updated).toBe(12);
  });

  it("rechaza un IVA mayor al máximo posible del mes o un mes sin ventas", async () => {
    vi.mocked(resolveCurrentAccount).mockResolvedValue(account("responsable_inscripto"));
    // 21/121 de 1.000.000 ≈ 173.553: 200.000 es imposible.
    const res = await PUT(req({ period: "2026-08", amount: 200000 }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("173.553");
    expect((await PUT(req({ period: "2026-07", amount: 1000 }))).status).toBe(400);
    expect(saveIvaPayment).not.toHaveBeenCalled();
  });

  it("amount null borra el mes", async () => {
    vi.mocked(resolveCurrentAccount).mockResolvedValue(account("responsable_inscripto"));
    expect((await PUT(req({ period: "2026-08", amount: null }))).status).toBe(200);
    expect(saveIvaPayment).toHaveBeenCalledWith({}, "acc1", "2026-08", null);
  });

  it("avisa si falta la migración", async () => {
    vi.mocked(resolveCurrentAccount).mockResolvedValue(account("responsable_inscripto"));
    vi.mocked(ivaPaymentsAvailable).mockResolvedValue(false);
    expect((await PUT(req({ period: "2026-08", amount: 1 }))).status).toBe(503);
  });
});
