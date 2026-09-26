import { NextRequest, NextResponse } from "next/server";
import { withScope } from "@/db/client";
import { hasColumn } from "@/db/schema-capabilities";
import { syncProductsPage, syncOrders, syncAds, syncFullStock, syncBillingCharges, recalculate, pendingOrderIds, backfillMissingProducts, syncProductEstimates } from "@/sync/sync-service";
import { deductsIvaFromProfit, setOrdersSyncedThrough } from "@/db/accounts";
import { listOrdersPage } from "@/mcp/tools";
import { resolveCurrentAccount } from "@/lib/current-account";
import { MlApiError } from "@/mcp/ml-client";

export const runtime = "nodejs";
/** Techo del plan Hobby. Aun así el historial va por lotes: ver abajo. */
export const maxDuration = 60;

const HISTORY_START_DATE = "2020-01-01";

/**
 * Cuando una cuenta ya completó un sync entero (`orders_synced_through`
 * guardado, ver migración 018), el próximo sync arranca acá atrás en vez de
 * desde el arranque del historial — margen para agarrar altas o cambios de
 * estado tardíos en órdenes recientes, sin tener que recorrer años enteros
 * que `pendingOrderIds` va a descartar de todos modos porque ya están al día
 * (esa función no vuelve a comparar el estado contra ML, solo mira si el
 * código con el que se procesaron cambió).
 */
const ORDERS_INCREMENTAL_LOOKBACK_DAYS = 30;

function addDaysStr(date: string, days: number): string {
  return new Date(new Date(`${date}T00:00:00Z`).getTime() + days * 86400000).toISOString().slice(0, 10);
}

/**
 * Órdenes que mira cada llamada. Es una página entera de la API, pero solo se
 * le piden a Mercado Libre las que están desatrasadas (ver pendingOrderIds),
 * así que un lote sin novedades cuesta dos consultas y termina al instante.
 * Traer todo en un request se pasaba del límite de tiempo de la función y
 * Vercel lo mataba a mitad de camino.
 */
const ORDERS_PER_BATCH = 50;

/**
 * Cuánto tiempo como máximo se le dedica a escanear catálogo en una sola
 * llamada, antes de cortar y seguir en la próxima. Deja margen bajo el techo
 * de 60s de la función (autenticación, conexión a la base, armar la
 * respuesta): una cuenta con decenas de miles de publicaciones no entra en
 * una sola pasada, y sin este corte Vercel mataba la función a mitad de
 * camino — el sync se caía entero en vez de simplemente tardar un poco más.
 */
const PRODUCTS_TIME_BUDGET_MS = 35_000;
/** Presupuesto del paso de estimación de cargos por producto (ver syncProductEstimates). */
const ESTIMATES_TIME_BUDGET_MS = 35_000;

/**
 * El cierre en sí mismo no entra siempre en una sola llamada: una cuenta con
 * un historial grande (decenas de miles de ventas) o un catálogo grande en
 * Full puede tardar más que el resto de sus pasos juntos. Se separa en estos
 * sub-pasos, cada uno en su propia llamada — mismo patrón que el catálogo y
 * las órdenes — para que ninguno se quede sin los 60s de la función a mitad
 * de camino. Cuando eso pasaba, como TODO el cierre corre en una sola
 * transacción, nada de lo que ya se había calculado llegaba a guardarse:
 * ads, stock de Full y facturación quedaban en cero para siempre, aunque el
 * botón "Sincronizar" se apretara una y otra vez.
 */
const FINALIZE_STEPS = ["ads", "backfill", "estimates", "fullstock", "recalc", "billing"] as const;
type FinalizeStep = (typeof FINALIZE_STEPS)[number];

interface SyncBody {
  /** scroll_id de catálogo para retomar el escaneo donde quedó. */
  productsScrollId?: string;
  /** Si el catálogo ya quedó sincronizado del todo (en esta corrida). */
  productsDone?: boolean;
  /** Desde qué fecha seguir con las órdenes (ver `listOrdersPage`). */
  ordersFrom?: string;
  /** Desde qué orden, dentro de esa ventana, seguir. */
  ordersOffsetInWindow?: number;
  /** Pide correr el cierre (ads, stock de Full, recálculo, facturación). */
  finalize?: boolean;
  /** En qué sub-paso del cierre seguir — ver FINALIZE_STEPS. Sin mandar, arranca desde el primero. */
  finalizeStep?: FinalizeStep;
  /** Desde qué inventory_id seguir sincronizando stock de Full. */
  fullStockOffset?: number;
  /** Desde qué línea de venta seguir recalculando ganancia neta. */
  recalcOffset?: number;
}

export async function POST(request: NextRequest) {
  const account = await resolveCurrentAccount();
  if (!account) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  if (!account.mlSellerId) {
    return NextResponse.json(
      { error: "Esta cuenta todavía no conectó Mercado Libre. Andá a /api/ml/login para autorizar." },
      { status: 400 }
    );
  }
  const sellerId = account.mlSellerId;

  const body = (await request.json().catch(() => ({}))) as SyncBody;
  const finalize = body.finalize === true;
  const finalizeStep: FinalizeStep = FINALIZE_STEPS.includes(body.finalizeStep as FinalizeStep)
    ? (body.finalizeStep as FinalizeStep)
    : "ads";
  const fullStockOffset = Math.max(0, Number(body.fullStockOffset ?? 0));
  const recalcOffset = Math.max(0, Number(body.recalcOffset ?? 0));
  const productsDone = body.productsDone === true;
  // Arranque de un sync nuevo (no la continuación de un lote en curso): usar
  // el checkpoint de la cuenta si ya completó una vuelta entera alguna vez.
  const freshOrdersFrom = account.ordersSyncedThrough
    ? addDaysStr(account.ordersSyncedThrough, -ORDERS_INCREMENTAL_LOOKBACK_DAYS)
    : HISTORY_START_DATE;
  const ordersFrom = body.ordersFrom ?? (freshOrdersFrom > HISTORY_START_DATE ? freshOrdersFrom : HISTORY_START_DATE);
  const offsetInWindow = Math.max(0, Number(body.ordersOffsetInWindow ?? 0));
  const ordersStarted = body.ordersFrom !== undefined || offsetInWindow > 0;

  try {
    const result = await withScope({ accountId: account.id }, async (client) => {
      const hasIva = await hasColumn(client, "order_items", "iva_applied");

      // Publicidad, recálculo, stock de Full y facturación dependen de tener
      // todas las órdenes cargadas, así que van al final — pero cada uno en
      // su PROPIA llamada, con su propio presupuesto de 60s (ver
      // FINALIZE_STEPS). Antes era un solo paso: para una cuenta con mucho
      // volumen (decenas de miles de ventas, catálogo grande en Full) el
      // cierre entero no entraba en el tiempo de una función — y como corre
      // en una sola transacción, si se cortaba a mitad de camino no quedaba
      // NADA guardado (ni ads, ni stock de Full, ni facturación), por más
      // veces que se reintentara. Pasó en producción con una cuenta real.
      const zeroed = { productsSynced: 0, ordersSynced: 0, adsRowsSynced: 0, billingChargesSynced: 0, fullStockSynced: 0, productsDone: true };

      const finalizePhase = async (step: FinalizeStep): Promise<Record<string, unknown>> => {
        switch (step) {
          case "ads": {
            const adsRowsSynced = await syncAds(client, account.id, sellerId, `${HISTORY_START_DATE}T00:00:00Z`);
            return { ...zeroed, adsRowsSynced, done: false, finalized: false, finalizeStep: "backfill" as FinalizeStep };
          }
          case "backfill": {
            // Le da nombre y foto a las publicaciones dadas de baja que se
            // vendieron, así aparecen en Productos y se les puede cargar el
            // costo — antes del recálculo, que depende de esos costos.
            await backfillMissingProducts(client, account.id, sellerId);
            return { ...zeroed, done: false, finalized: false, finalizeStep: "estimates" as FinalizeStep };
          }
          case "estimates": {
            // Lo que Mercado Libre cobraría hoy por vender cada producto (para
            // el margen real en Productos). Por tandas: se repite este mismo
            // paso hasta que no quede nada desactualizado.
            const { done } = await syncProductEstimates(client, account.id, sellerId, Date.now() + ESTIMATES_TIME_BUDGET_MS);
            return { ...zeroed, done: false, finalized: false, finalizeStep: (done ? "fullstock" : "estimates") as FinalizeStep };
          }
          case "fullstock": {
            // Depende del catálogo ya sincronizado (necesita el inventory_id
            // de cada producto), no de las órdenes. Por lotes: ver
            // syncFullStock.
            const { synced, nextOffset } = await syncFullStock(client, account.id, fullStockOffset);
            if (nextOffset !== null) {
              return { ...zeroed, fullStockSynced: synced, done: false, finalized: false, finalizeStep: "fullstock" as FinalizeStep, fullStockOffset: nextOffset };
            }
            return { ...zeroed, fullStockSynced: synced, done: false, finalized: false, finalizeStep: "recalc" as FinalizeStep };
          }
          case "recalc": {
            const { done, nextOffset } = await recalculate(
              client, account.id, hasIva, account.otherTaxRate, deductsIvaFromProfit(account.taxCondition), recalcOffset
            );
            if (!done) {
              return { ...zeroed, done: false, finalized: false, finalizeStep: "recalc" as FinalizeStep, recalcOffset: nextOffset ?? 0 };
            }
            return { ...zeroed, done: false, finalized: false, finalizeStep: "billing" as FinalizeStep };
          }
          case "billing": {
            const billingChargesSynced = await syncBillingCharges(client, account.id);
            // Recién ahora queda confirmado que todo el historial hasta hoy
            // está al día: el próximo sync puede arrancar cerca de acá en
            // vez de desde cero.
            const today = new Date().toISOString().slice(0, 10);
            await setOrdersSyncedThrough(client, account.id, today);
            return { ...zeroed, billingChargesSynced, done: true, finalized: true };
          }
        }
      };

      if (finalize) return finalizePhase(finalizeStep);

      const ordersPhase = async (productsSynced: number, from: string, offset: number) => {
        const today = new Date().toISOString().slice(0, 10);
        const page = await listOrdersPage(account.id, sellerId, from, today, offset, ORDERS_PER_BATCH);
        const pending = await pendingOrderIds(client, account.id, page.ids);
        const ordersSynced = await syncOrders(client, account.id, pending, hasIva, account.otherTaxRate, deductsIvaFromProfit(account.taxCondition));

        return {
          done: page.done,
          productsSynced,
          ordersSynced,
          adsRowsSynced: 0,
          billingChargesSynced: 0,
          fullStockSynced: 0,
          productsDone: true,
          ordersFrom: page.nextFrom,
          ordersOffsetInWindow: page.nextOffsetInWindow,
          // Todavía falta el cierre: el cliente tiene que pedirlo aparte.
          finalized: page.done ? false : undefined,
        };
      };

      // El catálogo se sincroniza una sola vez, al arrancar — pero uno
      // grande (decenas de miles de publicaciones) no entra en el tiempo de
      // una sola función. Se escanea por páginas de scroll hasta terminar,
      // cortando y devolviendo `nextScrollId` si hace falta más de una
      // llamada; si el catálogo entero entró en esta misma pasada, sigue
      // derecho con las órdenes en vez de gastar una ida y vuelta solo para
      // avisar que ya terminó.
      if (!ordersStarted && !productsDone) {
        const deadline = Date.now() + PRODUCTS_TIME_BUDGET_MS;
        const { productsSynced, nextScrollId } = await syncProductsPage(
          client, account.id, sellerId, body.productsScrollId, deadline
        );
        if (nextScrollId) {
          return {
            done: false,
            productsSynced,
            ordersSynced: 0,
            adsRowsSynced: 0,
            billingChargesSynced: 0,
            fullStockSynced: 0,
            productsScrollId: nextScrollId,
            productsDone: false,
          };
        }
        return ordersPhase(productsSynced, ordersFrom, 0);
      }

      return ordersPhase(0, ordersFrom, offsetInWindow);
    });

    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof MlApiError && err.status === 429) {
      // Mercado Libre sigue limitando la velocidad después de los reintentos
      // internos de mlFetch (ver mcp/ml-client.ts) — es transitorio y no se
      // perdió ningún avance (el checkpoint del lote sigue valiendo), así que
      // se devuelve un status distinto de un error genérico para que
      // SyncButton lo reintente solo, igual que ya hace con un 504.
      return NextResponse.json(
        { error: "Mercado Libre está limitando la velocidad de sincronización en este momento. Reintentando…" },
        { status: 429 }
      );
    }
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
