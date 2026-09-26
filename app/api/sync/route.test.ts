import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/db/client", () => ({ withScope: vi.fn() }));
vi.mock("@/sync/sync-service", () => ({
  syncProductsPage: vi.fn().mockResolvedValue({ productsSynced: 0, nextScrollId: undefined }),
  syncOrders: vi.fn().mockResolvedValue(0),
  syncAds: vi.fn().mockResolvedValue(0),
  syncFullStock: vi.fn().mockResolvedValue({ synced: 0, nextOffset: null }),
  syncBillingCharges: vi.fn().mockResolvedValue(0),
  recalculate: vi.fn().mockResolvedValue({ done: true, nextOffset: null }),
  backfillMissingProducts: vi.fn().mockResolvedValue(0),
  syncProductEstimates: vi.fn().mockResolvedValue({ updated: 0, done: true }),
  pendingOrderIds: vi.fn(async (_db: unknown, _acc: string, ids: string[]) => ids),
}));
vi.mock("@/mcp/tools", () => ({ listOrdersPage: vi.fn() }));
vi.mock("@/lib/current-account", () => ({ resolveCurrentAccount: vi.fn() }));
vi.mock("@/db/accounts", async () => {
  const actual = await vi.importActual<typeof import("@/db/accounts")>("@/db/accounts");
  return { ...actual, setOrdersSyncedThrough: vi.fn() };
});

import { POST } from "./route";
import { withScope } from "@/db/client";
import { syncOrders, syncProductsPage, syncFullStock, recalculate, pendingOrderIds, backfillMissingProducts, syncProductEstimates } from "@/sync/sync-service";
import { listOrdersPage } from "@/mcp/tools";
import { resolveCurrentAccount } from "@/lib/current-account";
import { setOrdersSyncedThrough } from "@/db/accounts";
import { MlApiError } from "@/mcp/ml-client";

/** El route lee `full` del body; los tests que no lo pasan mandan uno vacío. */
function req(body: unknown = {}) {
  return { json: async () => body } as any;
}

const NO_MORE_ORDERS = { ids: [], nextFrom: "9999-12-31", nextOffsetInWindow: 0, done: true };

describe("POST /api/sync", () => {
  beforeEach(() => vi.clearAllMocks());

  it("le avisa a syncOrders y a recalculate que esta cuenta es Monotributista", async () => {
    // El bug real que lo motivó: una cuenta Monotributista se estaba
    // sincronizando como si fuera Responsable Inscripto, así que se le
    // restaba un saldo de IVA que no le corresponde pagar.
    vi.mocked(resolveCurrentAccount).mockResolvedValue({
      id: "acc1", mlSellerId: "S1", otherTaxRate: 0, taxCondition: "monotributo",
    } as any);
    vi.mocked(withScope).mockImplementation((ctx: any, fn: any) => fn({ query: vi.fn().mockResolvedValue({ rows: [] }) }));
    vi.mocked(listOrdersPage).mockResolvedValue(NO_MORE_ORDERS);

    await POST(req({ productsDone: true }));
    // El cierre (donde corre recalculate) se pide en una llamada aparte, una
    // vez que el historial de órdenes ya está al día — y recalc es un
    // sub-paso más adentro del cierre (ver FINALIZE_STEPS), así que se pide
    // directamente en vez de tener que pasar por ads/backfill/fullstock antes.
    await POST(req({ finalize: true, finalizeStep: "recalc" }));

    expect(vi.mocked(syncOrders).mock.calls[0][5]).toBe(false);
    expect(vi.mocked(recalculate).mock.calls[0][4]).toBe(false);
  });

  it("returns 401 when there is no active account", async () => {
    vi.mocked(resolveCurrentAccount).mockResolvedValue(null);

    const res = await POST(req());

    expect(res.status).toBe(401);
  });

  it("returns 400 when the account has not connected Mercado Libre", async () => {
    vi.mocked(resolveCurrentAccount).mockResolvedValue({
      id: "acc1",
      name: "Cuenta",
      ownerEmail: "a@example.com",
      mlSellerId: null,
      otherTaxRate: 0, taxCondition: "responsable_inscripto" as const, taxConditionConfirmed: true,
      createdAt: "2026-01-01T00:00:00Z",
    });

    const res = await POST(req());

    expect(res.status).toBe(400);
  });

  it("walks the order history in batches and reports the next date/offset to resume from", async () => {
    vi.mocked(resolveCurrentAccount).mockResolvedValue({ id: "acc1", mlSellerId: "S1", otherTaxRate: 0, taxCondition: "responsable_inscripto" } as any);
    vi.mocked(withScope).mockImplementation((ctx: any, fn: any) => fn({ query: vi.fn().mockResolvedValue({ rows: [] }) }));
    vi.mocked(listOrdersPage).mockResolvedValue({ ids: ["1", "2"], nextFrom: "2020-04-01", nextOffsetInWindow: 30, done: false });
    vi.mocked(syncOrders).mockResolvedValue(2);

    const body = await (await POST(req({ productsDone: true, ordersFrom: "2020-04-01", ordersOffsetInWindow: 0 }))).json();

    expect(vi.mocked(listOrdersPage).mock.calls[0][2]).toBe("2020-04-01");
    expect(vi.mocked(listOrdersPage).mock.calls[0][4]).toBe(0);
    expect(body).toMatchObject({ done: false, ordersFrom: "2020-04-01", ordersOffsetInWindow: 30 });
    // El catálogo solo en el primer lote; el recálculo solo en el último.
    expect(vi.mocked(syncProductsPage)).not.toHaveBeenCalled();
    expect(vi.mocked(recalculate)).not.toHaveBeenCalled();
  });

  it("arranca las órdenes desde HISTORY_START cuando el cliente no manda ordersFrom", async () => {
    vi.mocked(resolveCurrentAccount).mockResolvedValue({ id: "acc1", mlSellerId: "S1", otherTaxRate: 0, taxCondition: "responsable_inscripto" } as any);
    vi.mocked(withScope).mockImplementation((ctx: any, fn: any) => fn({ query: vi.fn().mockResolvedValue({ rows: [] }) }));
    vi.mocked(listOrdersPage).mockResolvedValue(NO_MORE_ORDERS);

    await POST(req({ productsDone: true }));

    expect(vi.mocked(listOrdersPage).mock.calls[0][2]).toBe("2020-01-01");
  });

  it("con una cuenta que ya completó un sync entero, arranca cerca del checkpoint en vez de desde HISTORY_START", async () => {
    // Una vez sincronizada, una orden vieja nunca se vuelve a comparar contra
    // ML (pendingOrderIds solo mira sync_version) — así que recorrer TODO el
    // historial en cada sync era trabajo desperdiciado. Con orders_synced_through
    // guardado, el próximo sync arranca 30 días antes de ahí (margen para
    // altas o cambios de estado tardíos), no desde 2020.
    vi.mocked(resolveCurrentAccount).mockResolvedValue({
      id: "acc1", mlSellerId: "S1", otherTaxRate: 0, taxCondition: "responsable_inscripto",
      ordersSyncedThrough: "2026-08-15",
    } as any);
    vi.mocked(withScope).mockImplementation((ctx: any, fn: any) => fn({ query: vi.fn().mockResolvedValue({ rows: [] }) }));
    vi.mocked(listOrdersPage).mockResolvedValue(NO_MORE_ORDERS);

    await POST(req({ productsDone: true }));

    expect(vi.mocked(listOrdersPage).mock.calls[0][2]).toBe("2026-07-16"); // 2026-08-15 menos 30 días
  });

  it("nunca arranca antes de HISTORY_START, aunque el checkpoint menos el margen caiga antes", async () => {
    vi.mocked(resolveCurrentAccount).mockResolvedValue({
      id: "acc1", mlSellerId: "S1", otherTaxRate: 0, taxCondition: "responsable_inscripto",
      ordersSyncedThrough: "2020-01-10",
    } as any);
    vi.mocked(withScope).mockImplementation((ctx: any, fn: any) => fn({ query: vi.fn().mockResolvedValue({ rows: [] }) }));
    vi.mocked(listOrdersPage).mockResolvedValue(NO_MORE_ORDERS);

    await POST(req({ productsDone: true }));

    expect(vi.mocked(listOrdersPage).mock.calls[0][2]).toBe("2020-01-01");
  });

  it("guarda el checkpoint (hasta hoy) cuando corre el cierre, no antes", async () => {
    vi.mocked(resolveCurrentAccount).mockResolvedValue({ id: "acc1", mlSellerId: "S1", otherTaxRate: 0, taxCondition: "responsable_inscripto" } as any);
    vi.mocked(withScope).mockImplementation((ctx: any, fn: any) => fn({ query: vi.fn().mockResolvedValue({ rows: [] }) }));
    vi.mocked(listOrdersPage).mockResolvedValue(NO_MORE_ORDERS);

    const body = await (await POST(req({ productsDone: true }))).json();
    expect(body).toMatchObject({ done: true, finalized: false });
    expect(vi.mocked(setOrdersSyncedThrough)).not.toHaveBeenCalled();

    // El cierre (donde se guarda el checkpoint) corre en su propia llamada,
    // con su propio presupuesto de 60s — no compite por tiempo con el lote
    // de órdenes que recién terminó (eso fue lo que se pasó del techo en
    // producción con una cuenta de mucho volumen). El checkpoint se guarda
    // recién en el último sub-paso ("billing"), así que se pide directo.
    await POST(req({ finalize: true, finalizeStep: "billing" }));

    expect(vi.mocked(setOrdersSyncedThrough)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(setOrdersSyncedThrough).mock.calls[0][1]).toBe("acc1");
    expect(vi.mocked(setOrdersSyncedThrough).mock.calls[0][2]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("no guarda el checkpoint si todavía queda historial de órdenes por recorrer", async () => {
    vi.mocked(resolveCurrentAccount).mockResolvedValue({ id: "acc1", mlSellerId: "S1", otherTaxRate: 0, taxCondition: "responsable_inscripto" } as any);
    vi.mocked(withScope).mockImplementation((ctx: any, fn: any) => fn({ query: vi.fn().mockResolvedValue({ rows: [] }) }));
    vi.mocked(listOrdersPage).mockResolvedValue({ ids: ["1"], nextFrom: "2020-04-01", nextOffsetInWindow: 0, done: false });

    await POST(req({ productsDone: true }));

    expect(vi.mocked(setOrdersSyncedThrough)).not.toHaveBeenCalled();
  });

  it("le pasa la fecha de hoy a listOrdersPage, no un total fijo de antemano", async () => {
    // El caso real que motivó todo esto: /orders/search rechaza un offset
    // mayor a 10.000 sobre el historial entero. listOrdersPage se encarga de
    // partir en ventanas seguras puertas adentro; acá solo hace falta
    // confirmar que la ruta le pasa "hoy" como tope, no una ventana fija.
    vi.mocked(resolveCurrentAccount).mockResolvedValue({ id: "acc1", mlSellerId: "S1", otherTaxRate: 0, taxCondition: "responsable_inscripto" } as any);
    vi.mocked(withScope).mockImplementation((ctx: any, fn: any) => fn({ query: vi.fn().mockResolvedValue({ rows: [] }) }));
    vi.mocked(listOrdersPage).mockResolvedValue(NO_MORE_ORDERS);

    await POST(req({ productsDone: true }));

    const todayArg = vi.mocked(listOrdersPage).mock.calls[0][3] as string;
    expect(todayArg).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("only asks Mercado Libre for the orders that are not up to date", async () => {
    vi.mocked(resolveCurrentAccount).mockResolvedValue({ id: "acc1", mlSellerId: "S1", otherTaxRate: 0, taxCondition: "responsable_inscripto" } as any);
    vi.mocked(withScope).mockImplementation((ctx: any, fn: any) => fn({ query: vi.fn().mockResolvedValue({ rows: [] }) }));
    vi.mocked(listOrdersPage).mockResolvedValue({ ids: ["1", "2", "3"], nextFrom: "2020-01-01", nextOffsetInWindow: 3, done: false });
    // Solo la 3 está desactualizada.
    vi.mocked(pendingOrderIds).mockResolvedValue(["3"]);

    await POST(req({ productsDone: true }));

    expect(vi.mocked(syncOrders).mock.calls[0][2]).toEqual(["3"]);
  });

  it("marks the order walk done but not finalized on the last batch, then finishes — ads, recalc and billing — on the finalize call", async () => {
    vi.mocked(resolveCurrentAccount).mockResolvedValue({ id: "acc1", mlSellerId: "S1", otherTaxRate: 0, taxCondition: "responsable_inscripto" } as any);
    vi.mocked(withScope).mockImplementation((ctx: any, fn: any) => fn({ query: vi.fn().mockResolvedValue({ rows: [] }) }));
    vi.mocked(listOrdersPage).mockResolvedValue({ ids: ["1"], nextFrom: "9999-12-31", nextOffsetInWindow: 0, done: true });
    vi.mocked(pendingOrderIds).mockImplementation(async (_d: any, _a: any, ids: any) => ids);

    const body = await (await POST(req({ productsDone: true, ordersFrom: "2026-06-01", ordersOffsetInWindow: 40 }))).json();
    expect(body).toMatchObject({ done: true, finalized: false });
    expect(vi.mocked(backfillMissingProducts)).not.toHaveBeenCalled();
    expect(vi.mocked(recalculate)).not.toHaveBeenCalled();

    // El cierre (ads, backfill, stock de Full, recálculo, facturación) va en
    // sus propias llamadas, una por sub-paso, cada una con su propio
    // presupuesto de 60s — así una cuenta de mucho volumen no se pasa del
    // techo justo en el último paso. Se recorre igual que lo hace el cliente
    // real (SyncButton), pidiendo el siguiente finalizeStep hasta terminar.
    let closingBody: any = { finalized: false };
    for (let i = 0; i < 10 && !closingBody.finalized; i += 1) {
      closingBody = await (
        await POST(req({ finalize: true, finalizeStep: closingBody.finalizeStep }))
      ).json();
    }

    expect(closingBody).toMatchObject({ done: true, finalized: true });
    // Le da nombre y foto a las publicaciones dadas de baja antes de recalcular:
    // si no corre, esas ventas siguen mostrándose como un id suelto.
    expect(vi.mocked(backfillMissingProducts)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(recalculate)).toHaveBeenCalled();
  });

  it("el cierre pasa por ads, backfill, estimación de cargos, stock de Full, recálculo y facturación en ese orden, cada uno en su propia llamada", async () => {
    vi.mocked(resolveCurrentAccount).mockResolvedValue({ id: "acc1", mlSellerId: "S1", otherTaxRate: 0, taxCondition: "responsable_inscripto" } as any);
    vi.mocked(withScope).mockImplementation((ctx: any, fn: any) => fn({ query: vi.fn().mockResolvedValue({ rows: [] }) }));

    const steps: (string | undefined)[] = [];
    let requestedStep: string | undefined;
    let closingBody: any = { finalized: false };
    for (let i = 0; i < 10 && !closingBody.finalized; i += 1) {
      steps.push(requestedStep ?? "ads");
      closingBody = await (await POST(req({ finalize: true, finalizeStep: requestedStep }))).json();
      requestedStep = closingBody.finalizeStep;
    }

    expect(steps).toEqual(["ads", "backfill", "estimates", "fullstock", "recalc", "billing"]);
    expect(closingBody).toMatchObject({ done: true, finalized: true });
  });

  it("sigue pidiendo stock de Full hasta que syncFullStock deja de devolver un nextOffset", async () => {
    vi.mocked(resolveCurrentAccount).mockResolvedValue({ id: "acc1", mlSellerId: "S1", otherTaxRate: 0, taxCondition: "responsable_inscripto" } as any);
    vi.mocked(withScope).mockImplementation((ctx: any, fn: any) => fn({ query: vi.fn().mockResolvedValue({ rows: [] }) }));
    vi.mocked(syncFullStock)
      .mockResolvedValueOnce({ synced: 300, nextOffset: 300 })
      .mockResolvedValueOnce({ synced: 300, nextOffset: 600 })
      .mockResolvedValueOnce({ synced: 51, nextOffset: null });

    const first = await (await POST(req({ finalize: true, finalizeStep: "fullstock", fullStockOffset: 0 }))).json();
    expect(first).toMatchObject({ finalized: false, finalizeStep: "fullstock", fullStockOffset: 300, fullStockSynced: 300 });

    const second = await (await POST(req({ finalize: true, finalizeStep: "fullstock", fullStockOffset: first.fullStockOffset }))).json();
    expect(second).toMatchObject({ finalized: false, finalizeStep: "fullstock", fullStockOffset: 600, fullStockSynced: 300 });

    const third = await (await POST(req({ finalize: true, finalizeStep: "fullstock", fullStockOffset: second.fullStockOffset }))).json();
    expect(third).toMatchObject({ finalized: false, finalizeStep: "recalc", fullStockSynced: 51 });
    expect(vi.mocked(syncFullStock).mock.calls.map((c) => c[2])).toEqual([0, 300, 600]);
  });

  it("sigue pidiendo el recálculo hasta que recalculate deja de devolver un nextOffset", async () => {
    vi.mocked(resolveCurrentAccount).mockResolvedValue({ id: "acc1", mlSellerId: "S1", otherTaxRate: 0, taxCondition: "responsable_inscripto" } as any);
    vi.mocked(withScope).mockImplementation((ctx: any, fn: any) => fn({ query: vi.fn().mockResolvedValue({ rows: [] }) }));
    vi.mocked(recalculate)
      .mockResolvedValueOnce({ done: false, nextOffset: 500 })
      .mockResolvedValueOnce({ done: true, nextOffset: null });

    const first = await (await POST(req({ finalize: true, finalizeStep: "recalc", recalcOffset: 0 }))).json();
    expect(first).toMatchObject({ finalized: false, finalizeStep: "recalc", recalcOffset: 500 });

    const second = await (await POST(req({ finalize: true, finalizeStep: "recalc", recalcOffset: first.recalcOffset }))).json();
    expect(second).toMatchObject({ finalized: false, finalizeStep: "billing" });
    expect(vi.mocked(recalculate).mock.calls.map((c) => c[5])).toEqual([0, 500]);
  });

  it("un catálogo grande corta el escaneo y devuelve el scroll_id, sin tocar órdenes todavía", async () => {
    // El caso real que motivó esto: una cuenta con muchísimas publicaciones
    // no entraba en el tiempo de una función serverless. En vez de fallar, el
    // servidor tiene que cortar el escaneo, avisar que falta seguir, y no
    // arrancar el lote de órdenes hasta que el catálogo esté completo.
    vi.mocked(resolveCurrentAccount).mockResolvedValue({ id: "acc1", mlSellerId: "S1", otherTaxRate: 0, taxCondition: "responsable_inscripto" } as any);
    vi.mocked(withScope).mockImplementation((ctx: any, fn: any) => fn({ query: vi.fn().mockResolvedValue({ rows: [] }) }));
    vi.mocked(syncProductsPage).mockResolvedValueOnce({ productsSynced: 3000, nextScrollId: "scroll-abc" });

    const body = await (await POST(req({ productsDone: false }))).json();

    expect(body).toMatchObject({ done: false, productsSynced: 3000, productsScrollId: "scroll-abc", productsDone: false });
    expect(vi.mocked(listOrdersPage)).not.toHaveBeenCalled();
    expect(vi.mocked(syncOrders)).not.toHaveBeenCalled();
  });

  it("retoma el escaneo del catálogo con el scroll_id que mandó el cliente", async () => {
    vi.mocked(resolveCurrentAccount).mockResolvedValue({ id: "acc1", mlSellerId: "S1", otherTaxRate: 0, taxCondition: "responsable_inscripto" } as any);
    vi.mocked(withScope).mockImplementation((ctx: any, fn: any) => fn({ query: vi.fn().mockResolvedValue({ rows: [] }) }));
    vi.mocked(syncProductsPage).mockResolvedValueOnce({ productsSynced: 500, nextScrollId: undefined });
    vi.mocked(listOrdersPage).mockResolvedValue(NO_MORE_ORDERS);

    await POST(req({ productsScrollId: "scroll-abc", productsDone: false }));

    expect(vi.mocked(syncProductsPage).mock.calls[0][3]).toBe("scroll-abc");
  });

  it("cuando el catálogo termina de escanear dentro de la misma pasada, sigue derecho con las órdenes", async () => {
    vi.mocked(resolveCurrentAccount).mockResolvedValue({ id: "acc1", mlSellerId: "S1", otherTaxRate: 0, taxCondition: "responsable_inscripto" } as any);
    vi.mocked(withScope).mockImplementation((ctx: any, fn: any) => fn({ query: vi.fn().mockResolvedValue({ rows: [] }) }));
    vi.mocked(syncProductsPage).mockResolvedValueOnce({ productsSynced: 12, nextScrollId: undefined });
    vi.mocked(listOrdersPage).mockResolvedValue(NO_MORE_ORDERS);

    const body = await (await POST(req({ productsDone: false }))).json();

    expect(vi.mocked(listOrdersPage)).toHaveBeenCalledTimes(1);
    expect(body).toMatchObject({ done: true, productsSynced: 12, productsDone: true });
  });

  it("una vez que el catálogo ya terminó (productsDone), no lo vuelve a escanear en lotes de órdenes siguientes", async () => {
    vi.mocked(resolveCurrentAccount).mockResolvedValue({ id: "acc1", mlSellerId: "S1", otherTaxRate: 0, taxCondition: "responsable_inscripto" } as any);
    vi.mocked(withScope).mockImplementation((ctx: any, fn: any) => fn({ query: vi.fn().mockResolvedValue({ rows: [] }) }));
    vi.mocked(listOrdersPage).mockResolvedValue(NO_MORE_ORDERS);

    await POST(req({ productsDone: true }));

    expect(vi.mocked(syncProductsPage)).not.toHaveBeenCalled();
  });

  it("una vez que arrancaron las órdenes (ordersFrom u offset > 0), no vuelve a escanear el catálogo aunque productsDone no venga", async () => {
    // Cubre el caso real: el cliente ya viene mandando progreso de órdenes,
    // así que aunque productsDone no esté explícito, no hay que reescanear.
    vi.mocked(resolveCurrentAccount).mockResolvedValue({ id: "acc1", mlSellerId: "S1", otherTaxRate: 0, taxCondition: "responsable_inscripto" } as any);
    vi.mocked(withScope).mockImplementation((ctx: any, fn: any) => fn({ query: vi.fn().mockResolvedValue({ rows: [] }) }));
    vi.mocked(listOrdersPage).mockResolvedValue(NO_MORE_ORDERS);

    await POST(req({ ordersOffsetInWindow: 20 }));

    expect(vi.mocked(syncProductsPage)).not.toHaveBeenCalled();
  });

  it("finalize:true corre solo el cierre, sin volver a tocar la búsqueda de órdenes", async () => {
    vi.mocked(resolveCurrentAccount).mockResolvedValue({ id: "acc1", mlSellerId: "S1", otherTaxRate: 0, taxCondition: "responsable_inscripto" } as any);
    vi.mocked(withScope).mockImplementation((ctx: any, fn: any) => fn({ query: vi.fn().mockResolvedValue({ rows: [] }) }));

    await POST(req({ finalize: true }));

    expect(vi.mocked(listOrdersPage)).not.toHaveBeenCalled();
    expect(vi.mocked(syncOrders)).not.toHaveBeenCalled();
  });

  it("returns a 500 with the error message when the sync fails", async () => {
    vi.mocked(resolveCurrentAccount).mockResolvedValue({ id: "acc1", mlSellerId: "S1", otherTaxRate: 0, taxCondition: "responsable_inscripto" } as any);
    vi.mocked(withScope).mockRejectedValue(new Error("boom"));

    const res = await POST(req());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "boom" });
  });

  it("returns a 429 with a friendly, retryable message when ML keeps rate-limiting after mlFetch's own retries", async () => {
    // El bug real: un 429 de ML terminaba mostrado en crudo en la pantalla de
    // Resumen ("ML API error 429 on /orders/search?...: local_rate_limited").
    // Con esto, SyncButton lo distingue de un error genérico (mismo trato que
    // ya le da a un 504) y no se le muestra texto técnico al vendedor.
    vi.mocked(resolveCurrentAccount).mockResolvedValue({ id: "acc1", mlSellerId: "S1", otherTaxRate: 0, taxCondition: "responsable_inscripto" } as any);
    vi.mocked(withScope).mockRejectedValue(new MlApiError(429, "ML API error 429 on /orders/search: local_rate_limited"));

    const res = await POST(req());

    expect(res.status).toBe(429);
    expect(await res.json()).not.toMatchObject({ error: expect.stringContaining("local_rate_limited") });
  });

  it("repite el paso de estimación de cargos hasta que no queda nada por estimar", async () => {
    vi.mocked(resolveCurrentAccount).mockResolvedValue({ id: "acc1", mlSellerId: "S1", otherTaxRate: 0, taxCondition: "responsable_inscripto" } as any);
    vi.mocked(withScope).mockImplementation((ctx: any, fn: any) => fn({ query: vi.fn().mockResolvedValue({ rows: [] }) }));
    vi.mocked(syncProductEstimates)
      .mockResolvedValueOnce({ updated: 300, done: false })
      .mockResolvedValueOnce({ updated: 12, done: true });

    const first = await (await POST(req({ finalize: true, finalizeStep: "estimates" }))).json();
    const second = await (await POST(req({ finalize: true, finalizeStep: first.finalizeStep }))).json();

    expect(first.finalizeStep).toBe("estimates");
    expect(second.finalizeStep).toBe("fullstock");
  });
});
