/**
 * Cotización pública del dólar (oficial y blue). Separado del route handler
 * porque Next.js solo permite exportar handlers HTTP y algunas constantes de
 * configuración desde un archivo route.ts — un export extra para tests (como
 * `resetCache`) rompe el build.
 */
const SOURCE_URLS: Record<"oficial" | "blue", string> = {
  oficial: "https://dolarapi.com/v1/dolares/oficial",
  blue: "https://dolarapi.com/v1/dolares/blue",
};

export interface Quote {
  compra: number;
  venta: number;
  fecha: string;
}

export interface ExchangeRates {
  oficial: Quote | null;
  blue: Quote | null;
}

// No hace falta pedirlo de nuevo en cada visita a Productos dentro de la
// misma instancia tibia de la función: la cotización no cambia segundo a
// segundo, y así se evita convertirse en un cliente pesado de la API pública.
const CACHE_TTL_MS = 3 * 60_000;
let cache: { at: number; data: ExchangeRates } | null = null;

async function fetchQuote(url: string): Promise<Quote | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const data = (await res.json()) as { compra?: number; venta?: number; fechaActualizacion?: string };
    if (typeof data.compra !== "number" || typeof data.venta !== "number") return null;
    return { compra: data.compra, venta: data.venta, fecha: data.fechaActualizacion ?? new Date().toISOString() };
  } catch {
    // Caído, lento, o cambió de forma: no hay cotización en vivo por ahora,
    // pero no tiene por qué romper el resto de la pantalla — el vendedor
    // siempre puede cargar un tipo de cambio a mano.
    return null;
  }
}

export async function getExchangeRates(): Promise<ExchangeRates> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.data;
  const [oficial, blue] = await Promise.all([fetchQuote(SOURCE_URLS.oficial), fetchQuote(SOURCE_URLS.blue)]);
  const data = { oficial, blue };
  cache = { at: Date.now(), data };
  return data;
}

/** Solo para tests. */
export function resetExchangeRateCache(): void {
  cache = null;
}
