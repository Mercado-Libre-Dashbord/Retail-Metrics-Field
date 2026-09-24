"use client";

import { useEffect, useRef, useState } from "react";
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
function NegativeMarginPanel({
  products,
  sameTitleCount,
  onShowBreakdown,
  onGoTo,
}: {
  products: Product[];
  sameTitleCount: (p: Product) => number;
  onShowBreakdown: (p: Product) => void;
  onGoTo: (p: Product) => void;
}) {
  const losing = products
    .filter((p) => p.negativeMargin)
    .sort((a, b) => (a.avgProfitPerUnit ?? 0) - (b.avgProfitPerUnit ?? 0));
  if (losing.length === 0) return null;
  return (
    <div className="missing-cost-panel" role="status">
      <p className="missing-cost-head">
        <strong>{losing.length} producto(s) vendiéndose a pérdida real.</strong> En promedio, cada unidad vendida
        dejó una ganancia neta negativa (ya con comisión, envío e impuestos reales descontados). Tocá{" "}
        <em>Ver desglose</em> para ver de dónde sale la pérdida, venta por venta.
      </p>
      <ul className="missing-cost-list">
        {losing.slice(0, 10).map((p) => {
          const twins = sameTitleCount(p);
          return (
            <li key={p.id} className="loss-row">
              <span className="missing-cost-title">
                {p.title}
                <span className="cell-sub">
                  Publicación {p.id}
                  {twins > 1 && (
                    <span className="loss-twins"> · Hay {twins} publicaciones con este nombre: revisá que el costo esté cargado en esta</span>
                  )}
                </span>
              </span>
              <span className="loss-actions">
                <span className="missing-cost-units missing-cost">{fmt(p.avgProfitPerUnit ?? 0)} / unidad</span>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => onShowBreakdown(p)}>
                  Ver desglose
                </button>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => onGoTo(p)}>
                  Ir al producto
                </button>
              </span>
            </li>
          );
        })}
      </ul>
      {losing.length > 10 && <p className="missing-cost-foot">Y {losing.length - 10} más.</p>}
    </div>
  );
}

interface BreakdownSale {
  orderId: string;
  date: string;
  quantity: number;
  revenue: number;
  commission: number;
  shipping: number;
  ads: number;
  cost: number | null;
  costPerUnit: number | null;
  taxes: number;
  iva: number;
  netProfit: number | null;
}

interface ProductBreakdown {
  productId: string;
  unitsSold: number;
  totals: { revenue: number; commission: number; shipping: number; ads: number; cost: number; taxes: number; iva: number; netProfit: number };
  healed: number;
  sales: BreakdownSale[];
}

/**
 * De dónde sale el beneficio de una publicación: venta − cada descuento,
 * por unidad promedio y venta por venta. Es la forma de comprobar a simple
 * vista qué costo se aplicó y qué se está comiendo la ganancia (envío,
 * comisión, publicidad), sin tener que bajar un Excel.
 */
function BreakdownPanel({
  product,
  data,
  loading,
  error,
  onClose,
}: {
  product: Product;
  data: ProductBreakdown | null;
  loading: boolean;
  error: string;
  onClose: () => void;
}) {
  const units = data?.unitsSold ?? 0;
  const perUnit = (n: number) => (units > 0 ? n / units : 0);
  const lines: { label: string; value: number; sign: 1 | -1 }[] = data
    ? [
        { label: "Venta", value: data.totals.revenue, sign: 1 },
        { label: "Comisión ML", value: data.totals.commission, sign: -1 },
        { label: "Envío", value: data.totals.shipping, sign: -1 },
        { label: "Publicidad", value: data.totals.ads, sign: -1 },
        { label: "Costo del producto", value: data.totals.cost, sign: -1 },
        { label: "Otros impuestos", value: data.totals.taxes, sign: -1 },
        { label: "IVA a pagar", value: data.totals.iva, sign: -1 },
      ]
    : [];
  const biggest = lines.filter((l) => l.sign === -1).sort((a, b) => b.value - a.value)[0];
  return (
    <section className="breakdown-panel" aria-label={`Desglose de ${product.title}`}>
      <div className="breakdown-head">
        <div style={{ minWidth: 0 }}>
          <h2 className="breakdown-title">{product.title}</h2>
          <span className="cell-sub">
            Publicación {product.id} · costo cargado hoy:{" "}
            {product.currentCost === null ? "ninguno" : fmt(product.currentCost)}
          </span>
        </div>
        <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>
          Cerrar
        </button>
      </div>
      {loading && <p className="field-hint">Cargando desglose…</p>}
      {error && <p className="field-error">{error}</p>}
      {data && !loading && (
        <>
          {data.healed > 0 && (
            <p className="breakdown-note">
              Se corrigieron {data.healed} venta(s) que tenían aplicado un costo viejo. El beneficio de abajo ya usa el
              costo cargado hoy.
            </p>
          )}
          {units === 0 ? (
            <p className="field-hint">Esta publicación no tiene ventas en el período elegido.</p>
          ) : (
            <>
              <table className="breakdown-waterfall">
                <thead>
                  <tr>
                    <th />
                    <th className="num">Por unidad</th>
                    <th className="num">Total ({units} u.)</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l) => (
                    <tr key={l.label} className={biggest && l === biggest && l.value > 0 ? "breakdown-biggest" : ""}>
                      <td>{l.sign === -1 ? `− ${l.label}` : l.label}</td>
                      <td className="num">{fmt(perUnit(l.value))}</td>
                      <td className="num">{fmt(l.value)}</td>
                    </tr>
                  ))}
                  <tr className="breakdown-total">
                    <td>= Beneficio</td>
                    <td className={`num ${data.totals.netProfit < 0 ? "missing-cost" : ""}`}>{fmt(perUnit(data.totals.netProfit))}</td>
                    <td className={`num ${data.totals.netProfit < 0 ? "missing-cost" : ""}`}>{fmt(data.totals.netProfit)}</td>
                  </tr>
                </tbody>
              </table>
              {biggest && biggest.value > 0 && (
                <p className="field-hint">
                  Lo que más pesa: <strong>{biggest.label}</strong> ({fmt(perUnit(biggest.value))} por unidad,{" "}
                  {data.totals.revenue > 0 ? `${((biggest.value / data.totals.revenue) * 100).toFixed(0)}%` : "—"} de la venta).
                </p>
              )}
              <div className="table-wrap table-scroll table-compact">
                <table>
                  <thead>
                    <tr>
                      <th>Fecha</th>
                      <th>Orden</th>
                      <th className="num">Cant.</th>
                      <th className="num">Venta</th>
                      <th className="num">Comisión</th>
                      <th className="num">Envío</th>
                      <th className="num">Publicidad</th>
                      <th className="num">Costo unit. aplicado</th>
                      <th className="num">Impuestos + IVA</th>
                      <th className="num">Beneficio</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.sales.slice(0, 30).map((sale) => (
                      <tr key={`${sale.orderId}-${sale.date}`}>
                        <td>{new Date(sale.date).toLocaleDateString("es-AR")}</td>
                        <td>{sale.orderId}</td>
                        <td className="num">{sale.quantity}</td>
                        <td className="num">{fmt(sale.revenue)}</td>
                        <td className="num">{fmt(sale.commission)}</td>
                        <td className="num">{fmt(sale.shipping)}</td>
                        <td className="num">{fmt(sale.ads)}</td>
                        <td className={`num ${sale.costPerUnit === null ? "missing-cost" : ""}`}>
                          {sale.costPerUnit === null ? "Sin costo" : fmt(sale.costPerUnit)}
                        </td>
                        <td className="num">{fmt(sale.taxes + sale.iva)}</td>
                        <td className={`num ${sale.netProfit !== null && sale.netProfit < 0 ? "missing-cost" : ""}`}>
                          {sale.netProfit === null ? "—" : fmt(sale.netProfit)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {data.sales.length > 30 && <p className="field-hint">Mostrando las 30 ventas más recientes de {data.sales.length}.</p>}
            </>
          )}
        </>
      )}
    </section>
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
 * Ordenamiento por columna, igual que hacer clic en el encabezado de una
 * columna en Excel: cada columna sortable tiene su propio menú con "de
 * menor a mayor" / "de mayor a menor" (o A→Z / Z→A para texto). Reemplaza al
 * viejo selector único "Ordenar por" — cada opción de ahí era, en los
 * hechos, ordenar por una de estas columnas en una dirección puntual
 * (nombre A-Z, más/menos vendidos = Vendidas desc/asc, etc.), así que nada
 * se pierde: ahora se elige la columna Y la dirección por separado, como en
 * una planilla.
 */
type SortKey = "title" | "currentPrice" | "effectiveStock" | "fullStockValue" | "currentCost" | "marginPct" | "unitsSold" | "lastSaleDate" | "totalProfit";
type SortDirection = "asc" | "desc";

function sortValue(p: Product, key: SortKey): string | number | null {
  switch (key) {
    case "title":
      return p.title.toLowerCase();
    case "currentPrice":
      return p.currentPrice;
    case "effectiveStock":
      return p.effectiveStock;
    case "fullStockValue":
      return p.fullStockValue;
    case "currentCost":
      return p.currentCost;
    case "marginPct":
      return p.marginPct;
    case "unitsSold":
      return p.unitsSold;
    case "lastSaleDate":
      return p.lastSaleDate; // ISO: ordena bien como texto.
    case "totalProfit":
      return p.totalProfit;
  }
}

/**
 * Los vacíos (sin costo cargado, sin margen porque no hay costo, nunca
 * vendido) van siempre al final, en cualquier dirección — mismo criterio
 * que usa Excel al ordenar una columna con celdas en blanco: un producto
 * "sin dato" no es ni el más chico ni el más grande, así que no debería
 * aparecer arriba de todo solo por ordenar de mayor a menor.
 */
function compareForSort(a: string | number | null, b: string | number | null, direction: SortDirection): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const raw = typeof a === "string" && typeof b === "string" ? a.localeCompare(b, "es") : (a as number) - (b as number);
  return direction === "asc" ? raw : -raw;
}

function sortProducts(products: Product[], key: SortKey, direction: SortDirection): Product[] {
  return [...products].sort((a, b) => compareForSort(sortValue(a, key), sortValue(b, key), direction));
}

/** Filtro "por nombre" del encabezado de Producto — también matchea SKU e
 * id de publicación, para encontrar un producto puntual sin tener que saber
 * el título exacto. */
function filterByName(products: Product[], query: string): Product[] {
  const q = query.trim().toLowerCase();
  if (!q) return products;
  return products.filter(
    (p) => p.title.toLowerCase().includes(q) || p.id.toLowerCase().includes(q) || (p.sku ?? "").toLowerCase().includes(q)
  );
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

/**
 * Encabezado de columna con menú de orden, igual que hacer clic en la
 * flechita de una columna en Excel: un menú chico con las dos direcciones
 * posibles ("de menor a mayor" / "de mayor a menor", o A→Z / Z→A para
 * texto). Usa <details> nativo en vez de manejar abierto/cerrado a mano:
 * es la forma más simple de tener un menú desplegable sin un listener
 * global de "clic afuera para cerrar".
 */
function SortableHeader({
  label, sortKey, activeKey, direction, onSort, ascLabel, descLabel, numeric,
}: {
  label: string;
  sortKey: SortKey;
  activeKey: SortKey;
  direction: SortDirection;
  onSort: (key: SortKey, direction: SortDirection) => void;
  ascLabel: string;
  descLabel: string;
  numeric?: boolean;
}) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const isActive = activeKey === sortKey;

  function choose(dir: SortDirection) {
    onSort(sortKey, dir);
    if (detailsRef.current) detailsRef.current.open = false;
  }

  return (
    <th className={numeric ? "num" : undefined}>
      <details ref={detailsRef} className="col-sort">
        <summary>
          {label}
          {isActive && <span aria-hidden="true"> {direction === "asc" ? "▲" : "▼"}</span>}
        </summary>
        <div className="col-sort-menu">
          <button type="button" onClick={() => choose("asc")}>
            {ascLabel}
          </button>
          <button type="button" onClick={() => choose("desc")}>
            {descLabel}
          </button>
        </div>
      </details>
    </th>
  );
}

export default function ProductosPage() {
  const [products, setProducts] = useState<Product[] | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("title");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  const [nameFilter, setNameFilter] = useState("");
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

  // Desglose "de dónde sale el beneficio" de una publicación puntual.
  const [breakdownFor, setBreakdownFor] = useState<Product | null>(null);
  const [breakdown, setBreakdown] = useState<ProductBreakdown | null>(null);
  const [breakdownLoading, setBreakdownLoading] = useState(false);
  const [breakdownError, setBreakdownError] = useState("");
  const breakdownRef = useRef<HTMLDivElement | null>(null);

  // Mercado Libre usa un ID distinto por publicación aunque el título sea
  // idéntico (catálogo + publicación propia, relanzadas, etc.). Cargar el
  // costo en una y no en la otra dejaba la pérdida "sin corregir" en la otra,
  // y parecía que el beneficio no se actualizaba. Por defecto, el costo (y su
  // borrado) se aplica a todas las publicaciones con el mismo nombre; se
  // puede destildar por fila si de verdad son productos distintos.
  const [applyToTwins, setApplyToTwins] = useState<Record<string, boolean>>({});

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

  // "Último mes completo" y "Rango personalizado" necesitan que
  // Vendidas/Beneficio vengan acotados a ESE período, no a todo el
  // historial — si no, un producto que también vendió después mostraría
  // números mezclados con ventas de otro momento.
  function periodParams(): Record<string, string> {
    if (soldWithin === "lastFullMonth") return lastFullMonthRange();
    if (soldWithin === "custom" && customFrom && customTo) return { from: customFrom, to: customTo };
    return {};
  }

  function load() {
    setLoadError("");
    const params = new URLSearchParams(periodParams()).toString();
    const query = params ? `?${params}` : "";
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

  function titleKey(title: string) {
    return title.trim().toLowerCase().replace(/\s+/g, " ");
  }

  const productsByTitle = new Map<string, Product[]>();
  for (const p of products ?? []) {
    const key = titleKey(p.title);
    productsByTitle.set(key, [...(productsByTitle.get(key) ?? []), p]);
  }

  function twinsOf(p: Product): Product[] {
    return (productsByTitle.get(titleKey(p.title)) ?? []).filter((other) => other.id !== p.id);
  }

  function showBreakdown(p: Product) {
    setBreakdownFor(p);
    setBreakdown(null);
    setBreakdownError("");
    setBreakdownLoading(true);
    const params = new URLSearchParams({ productId: p.id, ...periodParams() });
    fetch(`/api/products/breakdown?${params}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        const data: ProductBreakdown = await r.json();
        setBreakdown(data);
        // Si el servidor tuvo que corregir ventas con un costo viejo, la
        // tabla de abajo quedó desactualizada: se vuelve a pedir.
        if (data.healed > 0) load();
      })
      .catch(() => setBreakdownError("No se pudo cargar el desglose. Probá de nuevo."))
      .finally(() => setBreakdownLoading(false));
    setTimeout(() => breakdownRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
  }

  function goToProduct(p: Product) {
    setNameFilter(p.id);
    setTimeout(() => document.getElementById(`cost-ars-${p.id}`)?.focus(), 50);
  }

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
      const twins = product && applyToTwins[productId] !== false ? twinsOf(product) : [];
      for (const twin of twins) {
        const res = await patchProduct({
          productId: twin.id,
          cost: rawCost,
          exchangeRate: hasValidRate ? rate : null,
          costCurrency: lastEditedCurrency[productId] ?? "ARS",
        });
        if (!res.ok) {
          setErrors((prev) => ({
            ...prev,
            [productId]: `Se guardó acá, pero no en la publicación ${twin.id}: ${res.data.error ?? "error desconocido"}.`,
          }));
        }
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
      const product = products?.find((p) => p.id === productId);
      const twins = product && applyToTwins[productId] !== false ? twinsOf(product).filter((t) => t.currentCost !== null) : [];
      for (const id of [productId, ...twins.map((t) => t.id)]) {
        const res = await fetch(`/api/products?productId=${encodeURIComponent(id)}`, { method: "DELETE" });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setErrors((prev) => ({ ...prev, [productId]: data.error ?? `No se pudo eliminar el costo de ${id}.` }));
          setConfirmingDeleteCostId(null);
          load();
          return;
        }
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
  const soldWithinFiltered = products ? filterProductsSoldWithin(products, soldWithin, customRange) : null;
  const nameFiltered = soldWithinFiltered ? filterByName(soldWithinFiltered, nameFilter) : null;
  const sortedProducts = nameFiltered ? sortProducts(nameFiltered, sortKey, sortDirection) : null;

  function toggleSort(key: SortKey, direction: SortDirection) {
    setSortKey(key);
    setSortDirection(direction);
  }

  return (
    <div>
      <h1>Productos</h1>
      <p className="field-hint" style={{ marginBottom: "var(--space-3)" }}>
        Cargá el costo de compra por unidad. Los impuestos no van acá: el IVA se calcula solo al 21% y el resto
        (IIBB, internos) se configura una sola vez en <a href="/configuracion">Configuración</a>.
      </p>
      {loadError && <p className="field-error" role="alert" style={{ marginBottom: "var(--space-3)" }}>{loadError}</p>}
      {products && (
        <NegativeMarginPanel
          products={products}
          sameTitleCount={(p) => twinsOf(p).length + 1}
          onShowBreakdown={showBreakdown}
          onGoTo={goToProduct}
        />
      )}
      <div ref={breakdownRef}>
        {breakdownFor && (
          <BreakdownPanel
            product={products?.find((p) => p.id === breakdownFor.id) ?? breakdownFor}
            data={breakdown}
            loading={breakdownLoading}
            error={breakdownError}
            onClose={() => setBreakdownFor(null)}
          />
        )}
      </div>
      {products && <LowStockPanel products={products} />}
      {products && products.length > 0 && (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginBottom: "var(--space-2)", flexWrap: "wrap" }}>
            <label htmlFor="search-products" className="field-hint" style={{ margin: 0 }}>
              Buscar producto
            </label>
            <input
              id="search-products"
              type="search"
              placeholder="Nombre, SKU o ID de publicación"
              value={nameFilter}
              onChange={(e) => setNameFilter(e.target.value)}
              style={{ padding: "6px 8px", minWidth: 220 }}
            />
            <span className="field-hint" style={{ margin: 0 }}>
              Para ordenar por precio, costo, margen, etc., hacé clic en el encabezado de esa columna.
            </span>
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
      ) : sortedProducts.length === 0 && nameFilter.trim() !== "" ? (
        <div className="empty-state">
          <p style={{ margin: 0, fontWeight: 600, color: "var(--text)" }}>
            Ningún producto coincide con &quot;{nameFilter}&quot;.
          </p>
          <p style={{ margin: "var(--space-2) 0 0" }}>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setNameFilter("")}>
              Borrar búsqueda
            </button>
          </p>
        </div>
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
                <SortableHeader
                  label="Producto" sortKey="title" activeKey={sortKey} direction={sortDirection} onSort={toggleSort}
                  ascLabel="Ordenar A → Z" descLabel="Ordenar Z → A"
                />
                <SortableHeader
                  label="Precio" sortKey="currentPrice" activeKey={sortKey} direction={sortDirection} onSort={toggleSort}
                  ascLabel="De menor a mayor" descLabel="De mayor a menor" numeric
                />
                <SortableHeader
                  label="Stock" sortKey="effectiveStock" activeKey={sortKey} direction={sortDirection} onSort={toggleSort}
                  ascLabel="De menor a mayor" descLabel="De mayor a menor" numeric
                />
                <SortableHeader
                  label="Valor en Full" sortKey="fullStockValue" activeKey={sortKey} direction={sortDirection} onSort={toggleSort}
                  ascLabel="De menor a mayor" descLabel="De mayor a menor" numeric
                />
                <SortableHeader
                  label="Costo (ARS)" sortKey="currentCost" activeKey={sortKey} direction={sortDirection} onSort={toggleSort}
                  ascLabel="De menor a mayor" descLabel="De mayor a menor" numeric
                />
                <th className="num">Costo (US$)</th>
                <SortableHeader
                  label="Margen" sortKey="marginPct" activeKey={sortKey} direction={sortDirection} onSort={toggleSort}
                  ascLabel="De menor a mayor" descLabel="De mayor a menor" numeric
                />
                <SortableHeader
                  label="Vendidas" sortKey="unitsSold" activeKey={sortKey} direction={sortDirection} onSort={toggleSort}
                  ascLabel="De menor a mayor" descLabel="De mayor a menor" numeric
                />
                <SortableHeader
                  label="Última venta" sortKey="lastSaleDate" activeKey={sortKey} direction={sortDirection} onSort={toggleSort}
                  ascLabel="Más antigua primero" descLabel="Más reciente primero"
                />
                <SortableHeader
                  label="Beneficio" sortKey="totalProfit" activeKey={sortKey} direction={sortDirection} onSort={toggleSort}
                  ascLabel="De menor a mayor" descLabel="De mayor a menor" numeric
                />
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
                        <span className="cell-sub">
                          {p.id}
                          {p.sku ? ` · SKU ${p.sku}` : ""}
                          {twinsOf(p).length > 0 && (
                            <span className="loss-twins"> · {twinsOf(p).length + 1} publicaciones con este nombre</span>
                          )}
                        </span>
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
                    {p.unitsSold > 0 ? (
                      <button type="button" className="link-num" onClick={() => showBreakdown(p)} title="Ver de dónde sale este beneficio">
                        {p.totalProfit.toFixed(2)}
                      </button>
                    ) : (
                      p.totalProfit.toFixed(2)
                    )}
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
                      {twinsOf(p).length > 0 && (
                        <label className="field-hint twins-toggle">
                          <input
                            type="checkbox"
                            checked={applyToTwins[p.id] !== false}
                            onChange={(e) => setApplyToTwins((prev) => ({ ...prev, [p.id]: e.target.checked }))}
                          />
                          Aplicar también a {twinsOf(p).length === 1 ? "la otra publicación" : `las otras ${twinsOf(p).length} publicaciones`} con este nombre
                        </label>
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
