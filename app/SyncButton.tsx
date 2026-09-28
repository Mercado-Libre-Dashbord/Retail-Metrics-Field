"use client";

import { useState } from "react";

/** Sub-pasos del cierre — ver la misma lista en app/api/sync/route.ts. */
type FinalizeStep = "ads" | "backfill" | "fullstock" | "recalc" | "billing";

interface SyncResponse {
  done: boolean;
  productsSynced: number;
  ordersSynced: number;
  adsRowsSynced: number;
  billingChargesSynced?: number;
  /** scroll_id de catálogo para retomar el escaneo donde quedó. */
  productsScrollId?: string;
  /** Si el catálogo ya quedó sincronizado del todo. */
  productsDone?: boolean;
  /** Desde qué fecha seguir con las órdenes. */
  ordersFrom?: string;
  /** Desde qué orden, dentro de esa ventana, seguir. */
  ordersOffsetInWindow?: number;
  /** Si el cierre (ads, stock de Full, recálculo, facturación) ya corrió. */
  finalized?: boolean;
  /** En qué sub-paso del cierre seguir, cuando finalized todavía es false. */
  finalizeStep?: FinalizeStep;
  /** Desde qué inventory_id seguir sincronizando stock de Full. */
  fullStockOffset?: number;
  /** Desde qué línea de venta seguir recalculando ganancia neta. */
  recalcOffset?: number;
  error?: string;
}

interface CallBody {
  productsScrollId?: string;
  productsDone?: boolean;
  ordersFrom?: string;
  ordersOffsetInWindow?: number;
  finalize?: boolean;
  finalizeStep?: FinalizeStep;
  fullStockOffset?: number;
  recalcOffset?: number;
}

export function SyncButton() {
  const [status, setStatus] = useState<"idle" | "syncing" | "done" | "error">("idle");
  const [message, setMessage] = useState("");
  const [progress, setProgress] = useState<string | null>(null);

  async function call(body: CallBody, attempt = 0): Promise<SyncResponse> {
    let res: Response;
    try {
      res = await fetch("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      // El fetch se cortó a nivel de red (señal débil, timeout, el servidor
      // cerró la conexión) — en Safari esto llega como el genérico "Load
      // failed", sin ningún detalle útil. Es justo el tipo de error
      // transitorio que un reintento suele resolver solo, así que se
      // reintenta un par de veces con espera creciente antes de rendirse.
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        return call(body, attempt + 1);
      }
      throw new Error("Se cortó la conexión con el servidor (señal débil o tardó demasiado). Probá de nuevo.");
    }

    // Un 504 es Vercel cortando la función por tardar demasiado — con un
    // lote puntual más pesado que lo normal (ej. una cuenta con mucho volumen
    // en Full) esto pasó una vez en producción y el reintento simplemente
    // funcionó, sin perder nada: el estado (scroll_id / fecha+offset) sigue
    // valiendo. Se reintenta igual que un corte de red en vez de mostrar un
    // error de una.
    // Un 429 es Mercado Libre limitando la velocidad después de que mlFetch
    // ya reintentó puertas adentro (ver mcp/ml-client.ts) — mismo caso: nada
    // se perdió, así que se reintenta en vez de cortar la sincronización.
    if ((res.status === 504 || res.status === 429) && attempt < 2) {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      return call(body, attempt + 1);
    }

    let data: SyncResponse;
    try {
      data = (await res.json()) as SyncResponse;
    } catch {
      // Una respuesta que no es JSON (por ejemplo, una página de error de
      // Vercel por timeout) daría un error de parseo ilegible en vez de
      // decir lo que realmente pasó.
      throw new Error(`El servidor no respondió bien (${res.status}). Probá de nuevo en un momento.`);
    }
    if (!res.ok) throw new Error(data.error ?? "Error desconocido");
    return data;
  }

  /**
   * Un solo sync que recorre todo el catálogo y todo el historial por lotes.
   * El servidor saltea las órdenes que ya están al día, así que después de la
   * primera vez esto termina en segundos aunque mire todas las ventas. Un
   * catálogo grande (decenas de miles de publicaciones) tampoco entra en una
   * sola llamada al servidor, así que primero puede haber varias vueltas
   * escaneando productos antes de que arranque el progreso de órdenes — y el
   * historial de órdenes va por ventanas de fecha (no un solo número de
   * offset), así que el progreso se muestra como cantidad procesada, no como
   * fracción de un total. El cierre (ads, stock de Full, recálculo,
   * facturación) se pide en una llamada aparte, con su propio presupuesto de
   * tiempo, recién cuando terminó de recorrer todo el historial de órdenes.
   */
  async function handleSync() {
    setStatus("syncing");
    setMessage("");
    setProgress(null);

    try {
      const totals = { products: 0, orders: 0, ads: 0, billing: 0 };
      let productsScrollId: string | undefined;
      let productsDone = false;
      let ordersFrom: string | undefined;
      let ordersOffsetInWindow = 0;

      // Cota de seguridad: si el servidor dejara de avanzar (ni el catálogo
      // ni la posición de órdenes), esto corta en vez de quedar girando para
      // siempre.
      for (let batch = 0; batch < 3000; batch += 1) {
        const data = await call({ productsScrollId, productsDone, ordersFrom, ordersOffsetInWindow });
        totals.products += data.productsSynced;
        totals.orders += data.ordersSynced;
        totals.ads += data.adsRowsSynced;
        totals.billing += data.billingChargesSynced ?? 0;

        productsDone = data.productsDone === true;

        if (!productsDone) {
          // Todavía escaneando el catálogo: uno grande no entra en una sola
          // llamada, así que esto puede tardar varias vueltas.
          if (data.productsScrollId === productsScrollId) {
            throw new Error("La sincronización del catálogo dejó de avanzar. Probá de nuevo.");
          }
          productsScrollId = data.productsScrollId;
          setProgress(`Escaneando catálogo… ${totals.products} publicaciones`);
          continue;
        }

        setProgress(`${totals.orders} órdenes sincronizadas…`);
        if (data.done) {
          if (!data.finalized) {
            // Todo el historial de órdenes ya está al día — falta el cierre
            // (ads, stock de Full, recálculo, facturación). Tampoco entra
            // siempre en una sola llamada (una cuenta con mucho volumen
            // puede tardar más en el recálculo o en el stock de Full que en
            // el resto del sync junto), así que se pide de a un sub-paso por
            // vez hasta que el servidor avisa que terminó del todo.
            setProgress("Cerrando sincronización…");
            let finalizeStep: FinalizeStep | undefined;
            let fullStockOffset = 0;
            let recalcOffset = 0;
            for (let step = 0; step < 200; step += 1) {
              const closing = await call({ finalize: true, finalizeStep, fullStockOffset, recalcOffset });
              totals.ads += closing.adsRowsSynced;
              totals.billing += closing.billingChargesSynced ?? 0;
              if (closing.finalized) break;
              finalizeStep = closing.finalizeStep;
              fullStockOffset = closing.fullStockOffset ?? 0;
              recalcOffset = closing.recalcOffset ?? 0;
            }
          }
          break;
        }

        const nextFrom = data.ordersFrom ?? ordersFrom;
        const nextOffsetInWindow = data.ordersOffsetInWindow ?? ordersOffsetInWindow;
        if (nextFrom === ordersFrom && nextOffsetInWindow === ordersOffsetInWindow) {
          throw new Error("La sincronización dejó de avanzar. Probá de nuevo.");
        }
        ordersFrom = nextFrom;
        ordersOffsetInWindow = nextOffsetInWindow;
      }

      setProgress(null);
      setMessage(
        `Listo · Productos: ${totals.products} · Ventas actualizadas: ${totals.orders} · Ads: ${totals.ads} · Cargos de ML: ${totals.billing}`
      );
      setStatus("done");
    } catch (err) {
      setProgress(null);
      setMessage((err as Error).message);
      setStatus("error");
    }
  }

  const syncing = status === "syncing";

  return (
    <div style={{ marginBottom: "var(--space-4)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", flexWrap: "wrap" }}>
        <button className="btn btn-primary" onClick={handleSync} disabled={syncing}>
          {syncing ? "Sincronizando…" : "Sincronizar"}
        </button>
        {progress && (
          <span
            role="status"
            aria-live="polite"
            className="field-hint"
            style={{ margin: 0, display: "inline-flex", alignItems: "center", gap: "var(--space-2)" }}
          >
            <span className="sync-spinner" aria-hidden="true" />
            {progress}
          </span>
        )}
        {message && (
          <span role="status" aria-live="polite" className={status === "error" ? "missing-cost" : "success-text"}>
            {message}
          </span>
        )}
      </div>
      <p className="field-hint" style={{ maxWidth: "70ch" }}>
        Trae tus ventas nuevas y recalcula envíos, IVA y ganancia de todo el historial. La primera vez puede
        tardar varios minutos; después es cuestión de segundos porque saltea lo que ya está al día.
      </p>
    </div>
  );
}
