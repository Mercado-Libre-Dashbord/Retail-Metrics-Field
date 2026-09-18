"use client";

import { useEffect, useState } from "react";
import { NoAccountState } from "../NoAccountState";

interface Product {
  id: string;
  title: string;
  sku: string | null;
  currentPrice: number;
  stock: number;
  currentCost: number | null;
  /** El mismo currentCost, convertido a dólares con el TC guardado junto al
   * costo (ver migración 019). Null si ese costo se cargó antes de que
   * existiera esto, o si nunca se cargó ningún costo. */
  currentCostUsd: number | null;
  thumbnail: string | null;
  unitsSold: number;
  totalProfit: number;
  marginPct: number | null;
  logisticType: string | null;
  fullStockQty: number | null;
  fullStockUnavailableQty: number | null;
  /** Stock guardado en Full si el producto está ahí; si no, el de la
   * publicación. Ya calculado del lado del servidor para que el aviso, el
   * resaltado de la fila y el número mostrado nunca puedan desacordar. */
  effectiveStock: number;
  fullStockValue: number | null;
  lowStockThreshold: number | null;
  lowStock: boolean;
  /** Última venta de este producto (de siempre, no del período elegido). Null
   * si nunca vendió nada. */
  lastSaleDate: string | null;
  /** Ganancia real por unidad de las ventas ya hechas (con la comisión,
   * envío e impuestos que se cobraron en cada caso) — null si todavía no
   * vendió nada, para no acusar pérdida sin ninguna venta real de fondo. */
  avgProfitPerUnit: number | null;
  negativeMargin: boolean;
}

function fmt(n: number) {
  return n.toLocaleString("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 });
}

function fmtUsd(n: number) {
  return n.toLocaleString("es-AR", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}

/**
 * A diferencia del margen de arriba (precio de hoy − costo − impuesto de la
 * cuenta, en teoría), esto mira lo que YA pasó: la comisión y el envío reales
 * de cada venta. Un producto puede tener margen teórico positivo y aun así
 * estar perdiendo plata en la práctica si el envío gratis o la comisión real
 * se comieron más de lo esperado — eso es lo que esta alerta agarra.
 */
function NegativeMarginPanel({ products }: { products: Product[] }) {
  const losing = products
    .filter((p) => p.negativeMargin)
    .sort((a, b) => (a.avgProfitPerUnit ?? 0) - (b.avgProfitPerUnit ?? 0));
  if (losing.length === 0) return null;
  return (
    <div className="missing-cost-panel" role="status">
      <p className="missing-cost-head">
        <strong>{losing.length} producto(s) vendiéndose a pérdida real.</strong> En promedio, cada unidad vendida
        dejó una ganancia neta negativa (ya con comisión, envío e impuestos reales descontados).
      </p>
      <ul className="missing-cost-list">
        {losing.slice(0, 10).map((p) => (
          <li key={p.id}>
            <span className="missing-cost-title">{p.title}</span>
            <span className="missing-cost-units missing-cost">{fmt(p.avgProfitPerUnit ?? 0)} / unidad</span>
          </li>
        ))}
      </ul>
      {losing.length > 10 && <p className="missing-cost-foot">Y {losing.length - 10} más.</p>}
    </div>
  );
}

/**
 * Avisa qué productos están por debajo del umbral de stock que el vendedor
 * configuró. Mismo criterio que el aviso de costos faltantes: una lista de
 * qué producto puntualmente hay que reponer, no solo un contador.
 */
function LowStockPanel({ products }: { products: Product[] }) {
  const low = products.filter((p) => p.lowStock);
  if (low.length === 0) return null;
  return (
    <div className="missing-cost-panel" role="status">
      <p className="missing-cost-head">
        <strong>{low.length} producto(s) con stock bajo el umbral configurado.</strong> Conviene reponerlos antes
        de quedarte sin stock.
      </p>
      <ul className="missing-cost-list">
        {low.slice(0, 10).map((p) => (
          <li key={p.id}>
            <span className="missing-cost-title">{p.title}</span>
            <span className="missing-cost-units">
              {p.effectiveStock} / {p.lowStockThreshold}{p.logisticType === "fulfillment" ? " (Full)" : ""}
            </span>
          </li>
        ))}
      </ul>
      {low.length > 10 && <p className="missing-cost-foot">Y {low.length - 10} más.</p>}
    </div>
  );
}

/**
 * Con un catálogo de miles de productos, cargar costos en orden alfabético
 * significa cargarlos todos antes de que el número de ganancia neta empiece
 * a acercarse a la realidad. Ordenar por lo que más vende (o por lo que hace
 * más que no vende) deja priorizar dónde cargar el costo primero rinde más.
 */
type SortMode = "name" | "mostSold" | "leastSold" | "recentSale" | "oldestSale";

const SORT_LABELS: Record<SortMode, string> = {
  name: "Nombre (A-Z)",
  mostSold: "Más vendidos primero",
  leastSold: "Menos vendidos primero",
  recentSale: "Vendidos más recientemente primero",
  oldestSale: "Hace más tiempo sin vender primero",
};

function sortProducts(products: Product[], mode: SortMode): Product[] {
  const sorted = [...products];
  switch (mode) {
    case "mostSold":
      return sorted.sort((a, b) => b.unitsSold - a.unitsSold);
    case "leastSold":
      return sorted.sort((a, b) => a.unitsSold - b.unitsSold);
    case "recentSale":
      // Los que nunca vendieron van al final: no hay fecha más "vieja" que
      // no tener ninguna venta todavía.
      return sorted.sort((a, b) => (b.lastSaleDate ?? "").localeCompare(a.lastSaleDate ?? ""));
    case "oldestSale":
      // Acá los que nunca vendieron van primero — son, en los hechos, los
      // que hace más tiempo (siempre) que no se mueven.
      return sorted.sort((a, b) => (a.lastSaleDate ?? "").localeCompare(b.lastSaleDate ?? ""));
    default:
      return sorted;
  }
}

/** Filtro por "vendido en los últimos X días" — en días de calendario, no
 * mes/semestre exactos: alcanza para priorizar carga de costos, no es un
 * cálculo financiero. `lastFullMonth` y `custom` son distintos a propósito:
 * no son una ventana relativa a hoy, sino un rango de fechas fijo (el mes
 * calendario ya cerrado, o uno elegido a mano), para contrastar contra un
 * período con números ya definitivos. */
type SoldWithinMode = "all" | "week" | "month" | "semester" | "lastFullMonth" | "custom";

const SOLD_WITHIN_LABELS: Record<SoldWithinMode, string> = {
  all: "Todos",
  week: "Última semana",
  month: "Último mes",
  semester: "Último semestre",
  lastFullMonth: "Último mes completo (cerrado)",
  custom: "Rango de fechas personalizado",
};

const SOLD_WITHIN_DAYS: Record<"week" | "month" | "semester", number> = {
  week: 7,
  month: 30,
  semester: 182,
};

/** [1º, último día] del mes calendario anterior al actual — ej. si hoy es
 * cualquier día de septiembre, devuelve agosto entero. */
function lastFullMonthRange(now = new Date()): { from: string; to: string } {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 0)); // día 0 del mes actual = último día del anterior
  return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
}

function lastFullMonthLabel(now = new Date()): string {
  const { from } = lastFullMonthRange(now);
  const d = new Date(`${from}T00:00:00Z`);
  const label = d.toLocaleDateString("es-AR", { month: "long", year: "numeric", timeZone: "UTC" });
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function filterProductsSoldWithin(
  products: Product[],
  mode: SoldWithinMode,
  customRange?: { from: string; to: string }
): Product[] {
  if (mode === "all") return products;
  if (mode === "custom") {
    // Sin las dos fechas todavía no hay nada que acotar: se muestra el
    // catálogo entero hasta que el vendedor termine de elegir el rango.
    if (!customRange) return products;
    // Igual que lastFullMonth: `unitsSold` ya viene acotado a ESE rango
    // (load() lo pide con from/to), no lastSaleDate.
    return products.filter((p) => p.unitsSold > 0);
  }
  if (mode === "lastFullMonth") {
    // Acá `unitsSold` ya viene acotado a ese mes (load() lo pide con
    // from/to) — no lastSaleDate, que sería la última venta de SIEMPRE y
    // podría ser más reciente que el mes cerrado que se quiere mirar.
    return products.filter((p) => p.unitsSold > 0);
  }
  const cutoff = Date.now() - SOLD_WITHIN_DAYS[mode] * 86400000;
  return products.filter((p) => p.lastSaleDate !== null && new Date(p.lastSaleDate).getTime() >= cutoff);
}

export default function ProductosPage() {
  const [products, setProducts] = useState<Product[] | null>(null);
  const [sortMode, setSortMode] = useState<SortMode>("name");
  const [soldWithin, setSoldWithin] = useState<SoldWithinMode>("all");
  // Rango de fechas para "Rango personalizado" — se pide solo cuando las dos
  // puntas están elegidas (ver filterProductsSoldWithin y load()).
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [noAccount, setNoAccount] = useState(false);
  const [loadError, setLoadError] = useState("");

  // Un costo cargado mal (típico: un cero de más) y corregido después seguía
  // afectando la ganancia de las ventas VIEJAS: sin ningún costo con fecha
  // anterior a la venta, el cálculo usa el PRIMER costo cargado como mejor
  // estimación (ver getCostEntryAtDate) — que quedaba siendo el erróneo, no
  // el corregido. Borrar el historial entero y cargarlo de nuevo hace que el
  // nuevo costo sea el único (y por lo tanto el "primero") — confirmación en
  // dos pasos, mismo patrón que borrar una cuenta en /admin.
  const [confirmingDeleteCostId, setConfirmingDeleteCostId] = useState<string | null>(null);
  const [deletingCostId, setDeletingCostId] = useState<string | null>(null);

  // Costo en edición, en las DOS monedas a la vez: escribir en una recalcula
  // la otra con el tipo de cambio de abajo, así nunca queda ambigüedad sobre
  // en qué moneda se está guardando un número (un botón "ARS/USD" al lado de
  // un solo campo la tenía: cambiar de moneda DESPUÉS de escribir el número
  // reinterpretaba el mismo texto sin avisar, y el costo en pesos terminaba
  // guardado mal — y con él, el margen y el "Valor en Full" de ese producto).
  // Sin entrada todavía = se muestra el costo ya guardado, no vacío, para
  // poder modificarlo sin tener que volver a escribirlo entero.
  const [costDraft, setCostDraft] = useState<Record<string, { ars: string; usd: string }>>({});
  // En qué moneda escribió el vendedor por última vez — solo para guardar un
  // dato informativo (`cost_currency`) junto al costo; el número en pesos
  // (canónico) sale igual de cualquiera de los dos campos.
  const [lastEditedCurrency, setLastEditedCurrency] = useState<Record<string, "ARS" | "USD">>({});

  function round2(n: number): number {
    return Math.round(n * 100) / 100;
  }

  function updateCostArs(productId: string, value: string) {
    const rate = Number(exchangeRate);
    const hasRate = exchangeRate.trim() !== "" && !Number.isNaN(rate) && rate > 0;
    const parsed = Number(value);
    setCostDraft((prev) => ({
      ...prev,
      [productId]: {
        ars: value,
        usd: hasRate && value.trim() !== "" && !Number.isNaN(parsed) ? String(round2(parsed / rate)) : "",
      },
    }));
    setLastEditedCurrency((prev) => ({ ...prev, [productId]: "ARS" }));
    if (errors[productId]) setErrors((prev) => ({ ...prev, [productId]: "" }));
  }

  function updateCostUsd(productId: string, value: string) {
    const rate = Number(exchangeRate);
    const hasRate = exchangeRate.trim() !== "" && !Number.isNaN(rate) && rate > 0;
    const parsed = Number(value);
    setCostDraft((prev) => ({
      ...prev,
      [productId]: {
        usd: value,
        // Sin TC válido no hay con qué convertir: se deja vacío A PROPÓSITO
        // (no el valor de pesos que hubiera antes) para que "Guardar" sin TC
        // falle con un error claro, en vez de guardar en silencio un costo
        // en pesos que no es el que se acaba de escribir en dólares.
        ars: hasRate && value.trim() !== "" && !Number.isNaN(parsed) ? String(round2(parsed * rate)) : "",
      },
    }));
    setLastEditedCurrency((prev) => ({ ...prev, [productId]: "USD" }));
    if (errors[productId]) setErrors((prev) => ({ ...prev, [productId]: "" }));
  }

  // Cotización del dólar oficial y blue, en vivo — para no obligar al
  // vendedor a ir a buscar el número a otro lado antes de cargar un costo en
  // dólares. "custom" deja pisarla a mano (por ejemplo, el TC que le cobra
  // puntualmente su proveedor, distinto de cualquiera de los dos públicos).
  const [rateSource, setRateSource] = useState<"oficial" | "blue" | "custom">("oficial");
  const [customRate, setCustomRate] = useState("");
  const [liveRates, setLiveRates] = useState<{
    oficial: { compra: number; venta: number; fecha: string } | null;
    blue: { compra: number; venta: number; fecha: string } | null;
  } | null>(null);
  const [liveRatesError, setLiveRatesError] = useState(false);

  useEffect(() => {
    try {
      const savedSource = localStorage.getItem("productos.rateSource");
      if (savedSource === "oficial" || savedSource === "blue" || savedSource === "custom") setRateSource(savedSource);
      const savedCustom = localStorage.getItem("productos.customRate");
      if (savedCustom) setCustomRate(savedCustom);
    } catch {
      // Modo privado o storage bloqueado: sin memoria entre visitas, no es
      // motivo para romper la pantalla.
    }
    fetch("/api/exchange-rate")
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        setLiveRates(await r.json());
      })
      .catch(() => setLiveRatesError(true));
  }, []);

  function updateRateSource(value: "oficial" | "blue" | "custom") {
    setRateSource(value);
    try {
      localStorage.setItem("productos.rateSource", value);
    } catch {
      // Igual que arriba: si no se puede guardar, no pasa nada grave.
    }
  }

  function updateCustomRate(value: string) {
    setCustomRate(value);
    try {
      localStorage.setItem("productos.customRate", value);
    } catch {
      // Igual que arriba.
    }
  }

  // TC efectivo que se usa para convertir costos: el de la fuente elegida
  // (con la punta de venta, que es la que importa para saber cuánto cuesta
  // COMPRAR dólares), o el personalizado si se optó por escribirlo a mano.
  const liveRate = rateSource !== "custom" ? liveRates?.[rateSource]?.venta ?? null : null;
  const exchangeRate = rateSource === "custom" ? customRate : liveRate !== null ? String(liveRate) : "";

  // Edición de precio/stock que se escribe de vuelta a la publicación real en
  // Mercado Libre — separado a propósito de "costDraft" (que es el costo,
  // interno nuestro, nunca toca ML).
  const [mlEditing, setMlEditing] = useState<Record<string, { price: string; stock: string }>>({});
  const [mlErrors, setMlErrors] = useState<Record<string, string>>({});
  const [mlSavingId, setMlSavingId] = useState<string | null>(null);

  function load() {
    setLoadError("");
    // "Último mes completo" y "Rango personalizado" necesitan que
    // Vendidas/Beneficio vengan acotados a ESE período, no a todo el
    // historial — si no, un producto que también vendió después mostraría
    // números mezclados con ventas de otro momento.
    let query = "";
    if (soldWithin === "lastFullMonth") {
      query = `?${new URLSearchParams(lastFullMonthRange())}`;
    } else if (soldWithin === "custom" && customFrom && customTo) {
      query = `?${new URLSearchParams({ from: customFrom, to: customTo })}`;
    }
    fetch(`/api/products${query}`)
      .then(async (r) => {
        if (r.status === 401) { setNoAccount(true); return; }
        if (!r.ok) throw new Error(String(r.status));
        setProducts(await r.json());
      })
      .catch(() => {
        // Sin esto la página se quedaba para siempre en "Cargando productos…"
        // cuando la API fallaba, y parecía que se habían borrado los costos.
        setLoadError("No se pudieron cargar los productos. Probá recargar la página.");
        setProducts([]);
      });
  }

  // Se vuelve a pedir cada vez que cambia el filtro de período (o las puntas
  // del rango personalizado): es la única forma de que "Último mes completo"
  // y "Rango personalizado" traigan los números acotados a ese período en vez
  // de a todo el historial.
  useEffect(load, [soldWithin, customFrom, customTo]);

  if (noAccount) {
    return (
      <div>
        <h1>Productos</h1>
        <NoAccountState />
      </div>
    );
  }

  function startMlEdit(p: Product) {
    setMlEditing((prev) => ({ ...prev, [p.id]: { price: String(p.currentPrice), stock: String(p.stock) } }));
  }

  function cancelMlEdit(productId: string) {
    setMlEditing((prev) => {
      const next = { ...prev };
      delete next[productId];
      return next;
    });
    setMlErrors((prev) => ({ ...prev, [productId]: "" }));
  }

  async function saveMlEdit(productId: string) {
    const draft = mlEditing[productId];
    const price = Number(draft?.price);
    if (!draft || Number.isNaN(price) || price <= 0) {
      setMlErrors((prev) => ({ ...prev, [productId]: "El precio tiene que ser mayor a 0." }));
      return;
    }
    // El stock de un producto en Full lo administra Mercado Libre por el
    // lado de la logística, no la publicación — ML rechaza cualquier intento
    // de tocarlo acá con "item.available_quantity.not_modifiable". Ni
    // siquiera se ofrece el campo para ese caso (ver el render más abajo),
    // así que tampoco se manda.
    const inFull = products?.find((p) => p.id === productId)?.logisticType === "fulfillment";
    const stock = inFull ? undefined : Number(draft.stock);
    if (!inFull && (Number.isNaN(stock) || (stock as number) < 0 || !Number.isInteger(stock))) {
      setMlErrors((prev) => ({ ...prev, [productId]: "Precio > 0 y stock entero ≥ 0." }));
      return;
    }
    setMlErrors((prev) => ({ ...prev, [productId]: "" }));
    setMlSavingId(productId);
    try {
      const res = await fetch("/api/products/ml-update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId, price, ...(stock !== undefined ? { stock } : {}) }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setMlErrors((prev) => ({ ...prev, [productId]: data.error ?? "No se pudo guardar en Mercado Libre." }));
        return;
      }
      cancelMlEdit(productId);
      load();
    } finally {
      setMlSavingId(null);
    }
  }

  async function patchProduct(body: Record<string, unknown>): Promise<{ ok: boolean; data: any }> {
    const res = await fetch("/api/products", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, data };
  }

  async function saveCost(productId: string) {
    const product = products?.find((p) => p.id === productId);
    const draft = costDraft[productId];
    // Sin haber tocado nada todavía, se guarda lo que ya estaba (mismo
    // fallback que muestra el campo ARS — ver el `value` del input): permite
    // apretar "Guardar" sin cambios sin que eso mande un costo vacío.
    const arsDraft = draft?.ars ?? (product?.currentCost !== null && product?.currentCost !== undefined ? String(product.currentCost) : "");
    const rawCost = Number(arsDraft);
    if (arsDraft.trim() === "" || Number.isNaN(rawCost) || rawCost < 0) {
      // Si hay algo cargado del lado de dólares pero el campo en pesos quedó
      // vacío, es porque falta el tipo de cambio para convertirlo (ver
      // updateCostUsd) — un error más específico que el genérico de abajo.
      const usdDraft = draft?.usd ?? "";
      setErrors((prev) => ({
        ...prev,
        [productId]:
          usdDraft.trim() !== ""
            ? "Ingresá el tipo de cambio arriba antes de guardar en dólares."
            : "Ingresá un costo (≥ 0), en pesos o en dólares.",
      }));
      return;
    }
    // El costo siempre se guarda en pesos (así calculan el margen todas las
    // ventas, en ARS) — el campo en pesos ya viene convertido si el vendedor
    // escribió en dólares (ver updateCostUsd). La sincronización con
    // Mercado Libre no se entera de nada de esto: sigue viendo un costo en
    // pesos, como siempre.
    const rate = Number(exchangeRate);
    const hasValidRate = exchangeRate.trim() !== "" && !Number.isNaN(rate) && rate > 0;
    setErrors((prev) => ({ ...prev, [productId]: "" }));
    setSavingId(productId);
    try {
      // El TC se manda siempre que haya uno cargado (aunque el costo se haya
      // escrito en pesos): así queda una foto de con qué cotización
      // equivalía a cuántos dólares, y se puede mostrar el costo en las dos
      // monedas sin que ese número se mueva solo con la cotización del día.
      const { ok, data } = await patchProduct({
        productId,
        cost: rawCost,
        exchangeRate: hasValidRate ? rate : null,
        costCurrency: lastEditedCurrency[productId] ?? "ARS",
      });
      if (!ok) {
        setErrors((prev) => ({ ...prev, [productId]: data.error ?? "No se pudo guardar el costo." }));
        return;
      }
      setCostDraft((prev) => {
        const next = { ...prev };
        delete next[productId];
        return next;
      });
      load();
    } finally {
      setSavingId(null);
    }
  }

  async function deleteCost(productId: string) {
    setErrors((prev) => ({ ...prev, [productId]: "" }));
    setDeletingCostId(productId);
    try {
      const res = await fetch(`/api/products?productId=${encodeURIComponent(productId)}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErrors((prev) => ({ ...prev, [productId]: data.error ?? "No se pudo eliminar el costo." }));
        setConfirmingDeleteCostId(null);
        return;
      }
      setCostDraft((prev) => {
        const next = { ...prev };
        delete next[productId];
        return next;
      });
      setConfirmingDeleteCostId(null);
      load();
    } finally {
      setDeletingCostId(null);
    }
  }

  const customRange = customFrom && customTo ? { from: customFrom, to: customTo } : undefined;
  const filteredProducts = products ? filterProductsSoldWithin(products, soldWithin, customRange) : null;
  const sortedProducts = filteredProducts ? sortProducts(filteredProducts, sortMode) : null;

  return (
    <div>
      <h1>Productos</h1>
      <p className="field-hint" style={{ marginBottom: "var(--space-3)" }}>
        Cargá el costo de compra por unidad. Los impuestos no van acá: el IVA se calcula solo al 21% y el resto
        (IIBB, internos) se configura una sola vez en <a href="/configuracion">Configuración</a>.
      </p>
      {loadError && <p className="field-error" role="alert" style={{ marginBottom: "var(--space-3)" }}>{loadError}</p>}
      {products && <NegativeMarginPanel products={products} />}
      {products && <LowStockPanel products={products} />}
      {products && products.length > 0 && (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginBottom: "var(--space-2)", flexWrap: "wrap" }}>
            <label htmlFor="sort-products" className="field-hint" style={{ margin: 0 }}>
              Ordenar por
            </label>
            <select
              id="sort-products"
              value={sortMode}
              onChange={(e) => setSortMode(e.target.value as SortMode)}
              style={{ padding: "6px 8px" }}
            >
              {(Object.keys(SORT_LABELS) as SortMode[]).map((mode) => (
                <option key={mode} value={mode}>{SORT_LABELS[mode]}</option>
              ))}
            </select>
            <label htmlFor="sold-within" className="field-hint" style={{ margin: 0 }}>
              Vendidos en
            </label>
            <select
              id="sold-within"
              value={soldWithin}
              onChange={(e) => setSoldWithin(e.target.value as SoldWithinMode)}
              style={{ padding: "6px 8px" }}
            >
              {(Object.keys(SOLD_WITHIN_LABELS) as SoldWithinMode[]).map((mode) => (
                <option key={mode} value={mode}>{SOLD_WITHIN_LABELS[mode]}</option>
              ))}
            </select>
            {soldWithin === "custom" && (
              <>
                <label htmlFor="custom-from" className="field-hint" style={{ margin: 0 }}>
                  Desde
                </label>
                <input
                  id="custom-from"
                  type="date"
                  value={customFrom}
                  max={customTo || undefined}
                  onChange={(e) => setCustomFrom(e.target.value)}
                  style={{ padding: "5px 6px" }}
                />
                <label htmlFor="custom-to" className="field-hint" style={{ margin: 0 }}>
                  Hasta
                </label>
                <input
                  id="custom-to"
                  type="date"
                  value={customTo}
                  min={customFrom || undefined}
                  onChange={(e) => setCustomTo(e.target.value)}
                  style={{ padding: "5px 6px" }}
                />
              </>
            )}
            <span className="field-hint" style={{ margin: 0 }}>
              {soldWithin === "lastFullMonth"
                ? `Vendidas y beneficio de ${lastFullMonthLabel()} solamente (mes ya cerrado, números definitivos).`
                : soldWithin === "custom"
                ? customFrom && customTo
                  ? `Vendidas y beneficio del ${new Date(`${customFrom}T00:00:00Z`).toLocaleDateString("es-AR", { timeZone: "UTC" })} al ${new Date(`${customTo}T00:00:00Z`).toLocaleDateString("es-AR", { timeZone: "UTC" })} solamente.`
                  : "Elegí las dos fechas para acotar Vendidas y Beneficio a ese rango exacto."
                : "Con un catálogo grande, priorizar por lo que más vende hace rendir más la carga de costos."}
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginBottom: "var(--space-3)", flexWrap: "wrap" }}>
            <label htmlFor="rate-source" className="field-hint" style={{ margin: 0 }}>
              Tipo de cambio (ARS por US$)
            </label>
            <select
              id="rate-source"
              value={rateSource}
              onChange={(e) => updateRateSource(e.target.value as "oficial" | "blue" | "custom")}
              style={{ padding: "6px 8px" }}
            >
              <option value="oficial">
                Dólar oficial{liveRates?.oficial ? ` ($${liveRates.oficial.venta.toLocaleString("es-AR")})` : ""}
              </option>
              <option value="blue">
                Dólar blue{liveRates?.blue ? ` ($${liveRates.blue.venta.toLocaleString("es-AR")})` : ""}
              </option>
              <option value="custom">Personalizado</option>
            </select>
            {rateSource === "custom" ? (
              <input
                id="exchange-rate"
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                placeholder="Ej: 1450"
                aria-label="Tipo de cambio personalizado"
                value={customRate}
                onChange={(e) => updateCustomRate(e.target.value)}
                style={{ width: 90, padding: "6px 8px" }}
              />
            ) : liveRate === null ? (
              <span className="field-error" role="alert">
                {liveRatesError
                  ? "No se pudo traer la cotización en vivo. Elegí \"Personalizado\" y cargala a mano."
                  : "Buscando cotización…"}
              </span>
            ) : null}
            <span className="field-hint" style={{ margin: 0 }}>
              Escribí el costo de cada producto en pesos o en dólares — el otro campo se completa solo con este tipo
              de cambio.
            </span>
          </div>
        </>
      )}
      {sortedProducts === null ? (
        <p className="empty-state">Cargando productos…</p>
      ) : sortedProducts.length === 0 && products && products.length > 0 ? (
        <div className="empty-state">
          <p style={{ margin: 0, fontWeight: 600, color: "var(--text)" }}>
            Ningún producto vendido en el período elegido.
          </p>
          <p style={{ margin: "var(--space-2) 0 0" }}>Probá con "Todos" o un período más largo en "Vendidos en".</p>
        </div>
      ) : sortedProducts.length === 0 ? (
        <div className="empty-state">
          <p style={{ margin: 0, fontWeight: 600, color: "var(--text)" }}>Todavía no hay productos sincronizados.</p>
          <p style={{ margin: "var(--space-2) 0 var(--space-3)" }}>
            Conectá Mercado Libre y sincronizá para traer tus publicaciones.
          </p>
          <a className="btn btn-primary btn-sm" href="/">Ir a Resumen y sincronizar</a>
        </div>
      ) : (
        <div className="table-wrap table-scroll table-compact">
          <table>
            <thead>
              <tr>
                <th>Producto</th>
                <th className="num">Precio</th>
                <th className="num">Stock</th>
                <th className="num">Valor en Full</th>
                <th className="num">Costo (ARS)</th>
                <th className="num">Costo (US$)</th>
                <th className="num">Margen</th>
                <th className="num">Vendidas</th>
                <th>Última venta</th>
                <th className="num">Beneficio</th>
                <th>Actualizar costo</th>
                <th>ML</th>
              </tr>
            </thead>
            <tbody>
              {sortedProducts.map((p) => (
                <tr key={p.id}>
                  <td>
                    <span className="cell-product">
                      {p.thumbnail ? (
                        <img className="cell-thumb" src={p.thumbnail} alt="" loading="lazy" />
                      ) : (
                        <span className="cell-thumb" aria-hidden="true" />
                      )}
                      <span style={{ minWidth: 0 }}>
                        <span className="cell-title" title={p.title}>{p.title}</span>
                        {p.sku && <span className="cell-sub">SKU {p.sku}</span>}
                      </span>
                    </span>
                  </td>
                  <td className="num">
                    {mlEditing[p.id] ? (
                      <input
                        type="number"
                        min="0.01"
                        step="0.01"
                        inputMode="decimal"
                        aria-label={`Precio nuevo para ${p.title}`}
                        value={mlEditing[p.id].price}
                        onChange={(e) => setMlEditing((prev) => ({ ...prev, [p.id]: { ...prev[p.id], price: e.target.value } }))}
                        style={{ width: 74, padding: "5px" }}
                      />
                    ) : (
                      p.currentPrice?.toFixed(2)
                    )}
                  </td>
                  <td className={`num ${p.lowStock ? "missing-cost" : ""}`}>
                    {mlEditing[p.id] && p.logisticType === "fulfillment" ? (
                      // El stock de un producto en Full no se puede tocar
                      // desde acá — Mercado Libre lo rechaza siempre. Se
                      // muestra igual que fuera de edición, sin campo.
                      <>
                        {p.effectiveStock} <span className="badge badge-other">Full</span>
                      </>
                    ) : mlEditing[p.id] ? (
                      <input
                        type="number"
                        min="0"
                        step="1"
                        inputMode="numeric"
                        aria-label={`Stock nuevo para ${p.title}`}
                        value={mlEditing[p.id].stock}
                        onChange={(e) => setMlEditing((prev) => ({ ...prev, [p.id]: { ...prev[p.id], stock: e.target.value } }))}
                        style={{ width: 54, padding: "5px" }}
                      />
                    ) : p.logisticType === "fulfillment" && p.fullStockQty !== null ? (
                      <>
                        {p.effectiveStock} <span className="badge badge-other">Full</span>
                      </>
                    ) : (
                      p.effectiveStock
                    )}
                  </td>
                  <td className="num">{p.fullStockValue === null ? "—" : p.fullStockValue.toFixed(2)}</td>
                  <td className={`num ${p.currentCost === null ? "missing-cost" : ""}`}>
                    {p.currentCost === null ? "Sin costo cargado" : p.currentCost.toFixed(2)}
                  </td>
                  <td className="num">{p.currentCostUsd === null ? "—" : fmtUsd(p.currentCostUsd)}</td>
                  <td className="num">{p.marginPct === null ? "-" : `${(p.marginPct * 100).toFixed(1)}%`}</td>
                  <td className="num">{p.unitsSold}</td>
                  <td>{p.lastSaleDate ? new Date(p.lastSaleDate).toLocaleDateString("es-AR") : "Nunca"}</td>
                  <td className={`num ${p.negativeMargin ? "missing-cost" : ""}`}>
                    {p.totalProfit.toFixed(2)}
                    {p.negativeMargin && (
                      <>
                        {" "}
                        <span className="badge badge-cancelled" title={`${fmt(p.avgProfitPerUnit ?? 0)} por unidad, en promedio`}>
                          pérdida
                        </span>
                      </>
                    )}
                  </td>
                  <td>
                    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
                      <div style={{ display: "flex", gap: "var(--space-1)", alignItems: "center", flexWrap: "wrap" }}>
                        <label htmlFor={`cost-ars-${p.id}`} className="field-hint" style={{ margin: 0 }}>
                          $
                        </label>
                        <input
                          id={`cost-ars-${p.id}`}
                          type="number"
                          min="0"
                          inputMode="decimal"
                          placeholder="Pesos"
                          aria-label={`Costo en pesos para ${p.title}`}
                          aria-invalid={errors[p.id] ? true : undefined}
                          value={costDraft[p.id]?.ars ?? (p.currentCost !== null ? String(p.currentCost) : "")}
                          onChange={(e) => updateCostArs(p.id, e.target.value)}
                          style={{ width: 76, padding: "6px" }}
                        />
                        <label htmlFor={`cost-usd-${p.id}`} className="field-hint" style={{ margin: 0 }}>
                          US$
                        </label>
                        <input
                          id={`cost-usd-${p.id}`}
                          type="number"
                          min="0"
                          inputMode="decimal"
                          placeholder="Dólares"
                          aria-label={`Costo en dólares para ${p.title}`}
                          value={costDraft[p.id]?.usd ?? (p.currentCostUsd !== null ? String(round2(p.currentCostUsd)) : "")}
                          onChange={(e) => updateCostUsd(p.id, e.target.value)}
                          style={{ width: 68, padding: "6px" }}
                        />
                        <button className="btn btn-secondary btn-sm" onClick={() => saveCost(p.id)} disabled={savingId === p.id}>
                          {savingId === p.id ? "…" : "Guardar"}
                        </button>
                      </div>
                      {confirmingDeleteCostId === p.id ? (
                        <div style={{ display: "flex", gap: "var(--space-1)", alignItems: "center", flexWrap: "wrap" }}>
                          <span className="field-hint" style={{ margin: 0 }}>¿Eliminar el costo cargado?</span>
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            style={{ color: "var(--negative)" }}
                            onClick={() => deleteCost(p.id)}
                            disabled={deletingCostId === p.id}
                          >
                            {deletingCostId === p.id ? "Eliminando…" : "Sí, eliminar"}
                          </button>
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={() => setConfirmingDeleteCostId(null)}
                            disabled={deletingCostId === p.id}
                          >
                            Cancelar
                          </button>
                        </div>
                      ) : (
                        p.currentCost !== null && (
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={() => setConfirmingDeleteCostId(p.id)}
                            title="Borra el costo cargado para poder cargarlo de nuevo desde cero"
                          >
                            Eliminar costo
                          </button>
                        )
                      )}
                      {errors[p.id] && <p className="field-error">{errors[p.id]}</p>}
                    </div>
                  </td>
                  <td>
                    {mlEditing[p.id] ? (
                      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)", alignItems: "start" }}>
                        <div style={{ display: "flex", gap: "var(--space-1)" }}>
                          <button className="btn btn-primary btn-sm" onClick={() => saveMlEdit(p.id)} disabled={mlSavingId === p.id}>
                            {mlSavingId === p.id ? "Guardando…" : "Guardar"}
                          </button>
                          <button className="btn btn-secondary btn-sm" onClick={() => cancelMlEdit(p.id)} disabled={mlSavingId === p.id}>
                            Cancelar
                          </button>
                        </div>
                        {p.logisticType === "fulfillment" && (
                          <p className="field-hint" style={{ margin: 0 }}>
                            El stock de un producto en Full lo administra Mercado Libre — acá solo se puede cambiar
                            el precio.
                          </p>
                        )}
                        {mlErrors[p.id] && <p className="field-error">{mlErrors[p.id]}</p>}
                      </div>
                    ) : (
                      <button className="btn btn-secondary btn-sm" onClick={() => startMlEdit(p)}>
                        Editar precio/stock
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
