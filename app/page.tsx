"use client";

import { Fragment, useEffect, useState, type ReactNode } from "react";
import {
  XAxis, YAxis, Tooltip, Legend, CartesianGrid, ResponsiveContainer,
  PieChart, Pie, Cell, AreaChart, Area,
} from "recharts";
import { SyncButton } from "./SyncButton";
import { NoAccountState } from "./NoAccountState";
import { PeriodBar } from "./PeriodBar";
import { Period, rangeForPeriod, toDateStr } from "@/lib/period";
import { countsAsRevenue } from "@/lib/order-status";
import { interpretCommissionCheck, type CommissionCheckInput } from "@/lib/commission-check";

interface PreviousTotals {
  orders: number;
  grossSales: number;
  netProfit: number;
  profitPct: number;
}

interface Summary {
  orders: number;
  grossSales: number;
  aov: number;
  netProfit: number;
  profitPct: number;
  netRevenue: number;
  itemsMissingCost: number;
  productsMissingCost: { productId: string; title: string; thumbnail: string | null; units: number }[];
  refundOrders: number;
  refundAmount: number;
  refundRate: number;
  /** null = Mercado Libre no dio el dato; distinto de 0 visitas. */
  visits: number | null;
  conversionRate: number | null;
  totalIva: number;
  totalCommission: number;
  totalShipping: number;
  adSpend: number;
  previous: PreviousTotals | null;
  /** SQL de migraciones pendientes — solo llega si sos admin. */
  pendingMigrations?: string[];
}

interface DailyBreakdown {
  day: string;
  revenue: number;
  commission: number;
  shipping: number;
  tax: number;
  iva: number;
  cost: number;
  ads: number;
  netProfit: number;
}

interface BillingBucket {
  bucket: string;
  label: string;
  amount: number;
}

interface Billing {
  available: boolean;
  commissionCheck?: CommissionCheckInput | null;
  buckets: BillingBucket[];
  total: number;
  charges?: number;
}

interface BillingStatus {
  periods: { key: string; dateFrom: string | null; dateTo: string | null; amount: number; periodStatus: string | null }[];
  restrictions: { confirmed: boolean; activeRestrictions: number | null };
}

interface OrderSummaryRow {
  orderId: string;
  estadoPago: string;
  dateCreated: string;
  totalOrder: number;
  totalNeto: number;
}

interface ProductRow {
  id: string;
  title: string;
  unitsSold: number;
  totalProfit: number;
  marginPct: number | null;
  stock: number;
  thumbnail: string | null;
  negativeMargin: boolean;
}

function fmt(n: number) {
  return n.toLocaleString("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 });
}
function pct(n: number) {
  return `${(n * 100).toFixed(2)}%`;
}

const ESTADO_LABEL: Record<string, string> = { paid: "Pagado", cancelled: "Cancelado", pending: "Pendiente" };
function estadoLabel(estado: string) {
  return ESTADO_LABEL[estado] ?? estado;
}
function estadoBadgeClass(estado: string) {
  if (estado === "paid") return "badge-paid";
  if (estado === "cancelled") return "badge-cancelled";
  return "badge-other";
}

function KpiValue({ children }: { children: React.ReactNode }) {
  if (children === "-") return <span className="skeleton" aria-hidden="true" />;
  return <>{children}</>;
}

interface OrderLineDetail {
  id: string;
  productId: string;
  productTitle: string;
  thumbnail: string | null;
  unitPrice: number;
  quantity: number;
  mlCommission: number;
  shippingCost: number;
  adsCostAllocated: number;
  costApplied: number | null;
  taxApplied: number | null;
  ivaApplied: number | null;
  netProfit: number | null;
}

/**
 * "Rentabilidad real por venta": el recibo de en qué se fue cada venta,
 * línea por línea. Todos los números ya salen de order_items — no se estima
 * nada acá, es lo que de verdad se descontó en esa operación puntual.
 */
function OrderReceipt({ items }: { items: OrderLineDetail[] | "loading" | "error" }) {
  if (items === "loading") return <p className="empty-state" style={{ padding: "var(--space-3)" }}>Cargando el detalle…</p>;
  if (items === "error") return <p className="field-error" style={{ padding: "var(--space-3)" }}>No se pudo traer el detalle de esta orden.</p>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)", padding: "var(--space-3) var(--space-4)" }}>
      {items.map((it) => {
        const revenue = it.unitPrice * it.quantity;
        const rows: { label: string; value: number | null }[] = [
          { label: "Precio de venta", value: revenue },
          { label: "− Comisión ML", value: -it.mlCommission },
          { label: "− Envío", value: -it.shippingCost },
          { label: "− Publicidad asignada", value: it.adsCostAllocated > 0 ? -it.adsCostAllocated : null },
          { label: "− IVA", value: it.ivaApplied !== null ? -it.ivaApplied : null },
          { label: "− Otros impuestos", value: it.taxApplied !== null ? -it.taxApplied : null },
          { label: "− Costo de producto", value: it.costApplied !== null ? -(it.costApplied * it.quantity) : null },
        ];
        return (
          <div key={it.id} style={{ fontSize: 13, maxWidth: 360 }}>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginBottom: 6, fontWeight: 600 }}>
              {it.thumbnail && <img src={it.thumbnail} alt="" className="cell-thumb" loading="lazy" />}
              <span>{it.productTitle} × {it.quantity}</span>
            </div>
            {rows.map((r) => (
              <div key={r.label} style={{ display: "flex", justifyContent: "space-between", padding: "2px 0", color: "var(--text-dim)" }}>
                <span>{r.label}</span>
                <span style={{ fontVariantNumeric: "tabular-nums" }}>{r.value === null ? "—" : fmt(r.value)}</span>
              </div>
            ))}
            <div
              style={{
                display: "flex", justifyContent: "space-between", marginTop: 4, paddingTop: 4,
                borderTop: "1px solid var(--border)", fontWeight: 700,
              }}
            >
              <span>= Ganancia neta real</span>
              <span style={{ color: it.netProfit === null ? "var(--text-dim)" : it.netProfit >= 0 ? "var(--positive)" : "var(--negative)" }}>
                {it.netProfit === null ? "Sin costo cargado" : fmt(it.netProfit)}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

const KPI_ICON_PATHS: Record<string, React.ReactNode> = {
  orders: (
    <>
      <circle cx="9" cy="20" r="1.4" />
      <circle cx="18" cy="20" r="1.4" />
      <path d="M2.5 3h2.5l2.3 12.2a2 2 0 0 0 2 1.6h8.4a2 2 0 0 0 2-1.6L21.5 7H6" />
    </>
  ),
  gross: <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />,
  aov: (
    <>
      <path d="M6 2v20l2-1.5L10 22l2-1.5L14 22l2-1.5L18 22V2H6z" />
      <path d="M9 7h6M9 11h6" />
    </>
  ),
  profit: <path d="M3 17l6-6 4 4 8-8M15 7h6v6" />,
  margin: (
    <>
      <circle cx="7" cy="7" r="2.5" />
      <circle cx="17" cy="17" r="2.5" />
      <path d="M18 6 6 18" />
    </>
  ),
  net: (
    <>
      <rect x="2.5" y="6" width="19" height="13" rx="2" />
      <path d="M2.5 10h19M16 14.5h3" />
    </>
  ),
  refund: (
    <>
      <path d="M3 12a9 9 0 1 0 2.6-6.4" />
      <path d="M3 3v5h5" />
    </>
  ),
  visits: (
    <>
      <path d="M1.5 12S5 5 12 5s10.5 7 10.5 7-3.5 7-10.5 7S1.5 12 1.5 12z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  ads: (
    <>
      <path d="m3 11 18-5v12L3 14v-3z" />
      <path d="M11.6 16.8a3 3 0 1 1-5.8-1.6" />
    </>
  ),
  question: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </>
  ),
  lossAlert: (
    <>
      <path d="M23 18l-9.5-9.5-5 5L1 6" />
      <path d="M17 18h6v-6" />
    </>
  ),
};

/** El ⓘ de cada tarjeta con la explicación de esa métrica. */
function KpiInfo({ children }: { children: React.ReactNode }) {
  return (
    <details className="kpi-info">
      <summary aria-label="Cómo se calcula">i</summary>
      <div className="kpi-info-panel">{children}</div>
    </details>
  );
}

function KpiIcon({ name }: { name: string }) {
  return (
    <span className="kpi-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        {KPI_ICON_PATHS[name]}
      </svg>
    </span>
  );
}

function DeltaPill({ current, previous }: { current: number; previous: number | null | undefined }) {
  if (previous === null || previous === undefined || previous <= 0) return null;
  const change = (current - previous) / previous;
  if (!Number.isFinite(change)) return null;
  const up = change >= 0;
  // El "vs. período anterior" va afuera de la píldora: adentro obligaba a la
  // píldora redondeada a partirse en dos líneas en las tarjetas angostas.
  return (
    <div className="kpi-delta">
      <span className={`delta-pill ${up ? "up" : "down"}`}>
        {up ? "↑" : "↓"} {Math.abs(change * 100).toLocaleString("es-AR", { maximumFractionDigits: 1 })}%
      </span>
      <span className="kpi-delta-caption">vs. período anterior</span>
    </div>
  );
}


/**
 * En qué se repartió la facturación del período: parte-de-un-todo con pocas
 * porciones, que es el caso en que una torta se lee de un vistazo. Los montos
 * y porcentajes van en la leyenda, porque comparar arcos parecidos a ojo no
 * funciona.
 *
 * Reemplaza al gráfico de barras apiladas que estaba abajo: los dos mostraban
 * la misma descomposición de la facturación, uno por día y otro agregado, y
 * la evolución en el tiempo ya la cubre "Rendimiento de ventas".
 */
function RevenueSplitPie({ daily }: { daily: DailyBreakdown[] }) {
  const totals = daily.reduce(
    (acc, d) => ({
      commission: acc.commission + d.commission,
      shipping: acc.shipping + d.shipping,
      tax: acc.tax + d.tax,
      iva: acc.iva + d.iva,
      cost: acc.cost + d.cost,
      ads: acc.ads + d.ads,
      netProfit: acc.netProfit + d.netProfit,
      revenue: acc.revenue + d.revenue,
    }),
    { commission: 0, shipping: 0, tax: 0, iva: 0, cost: 0, ads: 0, netProfit: 0, revenue: 0 }
  );

  // El color va pegado al concepto, no a la posición. Antes salía de un
  // índice sobre la lista ya filtrada: a un vendedor sin "otros impuestos" se
  // le corrían todos los colores de ahí para abajo, y el mismo concepto
  // cambiaba de color entre dos cuentas.
  const slices = [
    { name: "Comisión ML", value: totals.commission, color: "var(--chart-commission)" },
    { name: "Envío", value: totals.shipping, color: "var(--chart-shipping)" },
    { name: "Costo de producto", value: totals.cost, color: "var(--chart-cost)" },
    { name: "IVA", value: totals.iva, color: "var(--chart-iva)" },
    { name: "Otros impuestos", value: totals.tax, color: "var(--chart-tax)" },
    { name: "Publicidad", value: totals.ads, color: "var(--chart-ads)" },
    { name: "Ganancia neta", value: totals.netProfit, color: "var(--positive)" },
  ];
  const revenue = totals.revenue;
  const visible = slices.filter((s) => s.value > 0);
  if (visible.length === 0) return null;

  return (
    <div className="chart-card" style={{ marginBottom: 0 }}>
      <div className="chart-card-head">
        <h3 className="chart-card-title">En qué se fue tu facturación</h3>
      </div>
      <div className="donut-wrap" style={{ width: "100%", minHeight: 200, position: "relative" }}>
        <ResponsiveContainer width="100%" height={200}>
          <PieChart>
            <Pie
              data={visible}
              dataKey="value"
              nameKey="name"
              innerRadius="60%"
              outerRadius="90%"
              paddingAngle={2}
              stroke="var(--surface)"
              strokeWidth={2}
              isAnimationActive={false}
            >
              {visible.map((slice, i) => (
                <Cell
                  key={slice.name}
                  fill={slice.color}
                />
              ))}
            </Pie>
            <Tooltip
              contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, color: "var(--text)" }}
              formatter={(value: number, name: string) => [
                `${fmt(value)} · ${revenue > 0 ? ((value / revenue) * 100).toFixed(1) : "0"}%`,
                name,
              ]}
            />
          </PieChart>
        </ResponsiveContainer>
        <div
          aria-hidden="true"
          style={{
            position: "absolute", inset: 0, display: "flex", flexDirection: "column",
            alignItems: "center", justifyContent: "center", pointerEvents: "none",
          }}
        >
          <span style={{ fontSize: 15, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{fmt(revenue)}</span>
          <span style={{ fontSize: 11, color: "var(--text-dim)" }}>facturado</span>
        </div>
      </div>
      <ul className="donut-legend">
        {visible.map((slice, i) => (
          <li key={slice.name}>
            <span
              className="donut-swatch"
              style={{ background: slice.color }}
            />
            <span className="donut-legend-name">{slice.name}</span>
            <span className="donut-legend-value">
              {revenue > 0 ? `${((slice.value / revenue) * 100).toFixed(0)}%` : "—"}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Los 5 productos que encabezan el período, en dos lecturas.
 *
 * "Más vendido" y "más rentable" casi nunca son el mismo producto, y ver las
 * dos listas es donde el vendedor toma decisiones. Antes eran dos bloques
 * separados —esta tarjeta y una tabla más abajo— que repetían las mismas
 * columnas; ahora es un solo lugar con un interruptor, así no hay que
 * comparar entre dos partes distintas de la página.
 *
 * La barra detrás de cada fila codifica la magnitud relativa al primero: el
 * orden se lee sin tener que comparar números.
 */
type TopMode = "vendidos" | "rentables";

function TopProductsCard({ rows }: { rows: ProductRow[] }) {
  const [mode, setMode] = useState<TopMode>("vendidos");

  const sold = rows.filter((p) => p.unitsSold > 0);
  const top =
    mode === "vendidos"
      ? [...sold].sort((a, b) => b.unitsSold - a.unitsSold).slice(0, 5)
      : [...sold].sort((a, b) => b.totalProfit - a.totalProfit).slice(0, 5);

  // La escala arranca en el máximo del modo activo: la barra es proporción
  // dentro de este top, no contra toda la cuenta.
  const peak = Math.max(
    ...top.map((p) => (mode === "vendidos" ? p.unitsSold : Math.max(p.totalProfit, 0))),
    1
  );

  return (
    <div className="chart-card">
      <div className="chart-card-head">
        <h3 className="chart-card-title">Top productos</h3>
        <div className="seg" role="group" aria-label="Ordenar el top">
          <button
            type="button"
            className={`seg-btn${mode === "vendidos" ? " active" : ""}`}
            aria-pressed={mode === "vendidos"}
            onClick={() => setMode("vendidos")}
          >
            Más vendidos
          </button>
          <button
            type="button"
            className={`seg-btn${mode === "rentables" ? " active" : ""}`}
            aria-pressed={mode === "rentables"}
            onClick={() => setMode("rentables")}
          >
            Más rentables
          </button>
        </div>
      </div>

      {top.length === 0 ? (
        <div className="empty-state" style={{ padding: "var(--space-5) var(--space-3)" }}>
          Sin ventas en este período.
        </div>
      ) : (
        <>
          <ol className="top-products">
            {top.map((p, i) => {
              const value = mode === "vendidos" ? p.unitsSold : p.totalProfit;
              const width = Math.max(2, (Math.max(value, 0) / peak) * 100);
              return (
                <li className="top-product" key={p.id}>
                  <span className="top-rank" aria-hidden="true">{i + 1}</span>
                  {p.thumbnail ? (
                    // <img> y no next/image: son URLs de mlstatic que cambian por
                    // cuenta, y no vale configurar dominios remotos para un thumb.
                    <img className="top-product-img" src={p.thumbnail} alt="" loading="lazy" />
                  ) : (
                    <span className="top-product-img" aria-hidden="true" />
                  )}
                  <span className="top-product-main">
                    <span className="top-product-name" title={p.title}>{p.title}</span>
                    <span className="top-product-bar" aria-hidden="true">
                      <span className="top-product-bar-fill" style={{ width: `${width}%` }} />
                    </span>
                    <span className="top-product-meta">
                      {p.unitsSold} vendidas ·{" "}
                      <span style={{ color: p.totalProfit >= 0 ? "var(--positive)" : "var(--negative)", fontWeight: 600 }}>
                        {fmt(p.totalProfit)}
                      </span>
                      {p.marginPct !== null && <> · {pct(p.marginPct)} de margen</>}
                    </span>
                  </span>
                  <span className="top-product-side">
                    <StockBadge stock={p.stock} />
                  </span>
                </li>
              );
            })}
          </ol>
          <p className="chart-card-foot">
            {mode === "vendidos"
              ? "Ordenado por unidades. Fijate la ganancia: el que más vende no siempre es el que más deja."
              : "Ordenado por ganancia neta real, ya descontando comisión, envío, publicidad, costo e impuestos."}{" "}
            <a href="/productos">Ver todos</a>
          </p>
        </>
      )}
    </div>
  );
}

/**
 * Huecos con la forma final del contenido mientras llegan los datos.
 *
 * No es decoración: reservan el alto real, así la página no salta cuando
 * responde la API, y dicen qué está por aparecer sin escribir "Cargando…".
 */
function KpiSkeleton({ count = 9 }: { count?: number }) {
  return (
    <div className="kpi-grid" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div className="skel-card" key={i}>
          <div className="skel" style={{ width: "45%", height: 11 }} />
          <div className="skel" style={{ width: "70%", height: 26 }} />
        </div>
      ))}
    </div>
  );
}

function ChartSkeleton({ height = 300 }: { height?: number }) {
  return (
    <div className="skel-chart" aria-hidden="true">
      <div className="skel" style={{ width: 220, height: 14, marginBottom: 20 }} />
      <div className="skel" style={{ width: "100%", height }} />
    </div>
  );
}

/**
 * Qué productos le faltan por costear, no solo cuántas líneas.
 *
 * El aviso anterior decía "N líneas de venta sin costo cargado" y nada más.
 * Como el que más aparece acá suele ser una publicación que ya no está
 * activa, el vendedor cargaba todo lo que veía en la lista y el número no se
 * movía: parecía que la carga no tomaba.
 */
function MissingCostPanel({
  items,
  products,
}: {
  items: number;
  products: { productId: string; title: string; thumbnail: string | null; units: number }[];
}) {
  return (
    <div className="missing-cost-panel" role="status">
      <p className="missing-cost-head">
        <strong>{items} línea(s) de venta sin costo cargado.</strong> Sus ventas quedan fuera de la ganancia
        neta — no se estima un valor.
      </p>
      {products.length > 0 && (
        <ul className="missing-cost-list">
          {products.map((p) => (
            <li key={p.productId}>
              <span className="cell-product" style={{ minWidth: 0 }}>
                {p.thumbnail ? (
                  <img className="cell-thumb" src={p.thumbnail} alt="" loading="lazy" />
                ) : (
                  <span className="cell-thumb" aria-hidden="true" />
                )}
                <span style={{ minWidth: 0 }}>
                  <span className="missing-cost-title" title={p.title}>{p.title}</span>
                  {/* El id abajo del nombre: es lo que hay que buscar en
                      Productos, y si el nombre no se pudo resolver es lo
                      único que identifica la publicación. */}
                  <span className="cell-sub">{p.productId}</span>
                </span>
              </span>
              <span className="missing-cost-units">{p.units} u.</span>
            </li>
          ))}
        </ul>
      )}
      <p className="missing-cost-foot">
        <a className="btn btn-secondary btn-sm" href="/productos">Cargar costos</a>
        <span>Si alguno ya no está publicado, igual aparece en Productos para que puedas costearlo.</span>
      </p>
    </div>
  );
}

const LOW_STOCK_THRESHOLD = 5;

function StockBadge({ stock }: { stock: number }) {
  const tone = stock <= 0 ? "out" : stock <= LOW_STOCK_THRESHOLD ? "low" : "ok";
  const label = stock <= 0 ? "Sin stock" : `${stock} en stock`;
  return (
    <span className={`stock-badge ${tone}`}>
      <span className="stock-dot" aria-hidden="true" />
      {label}
    </span>
  );
}

/**
 * En qué se repartió la facturación, día por día.
 *
 * La torta responde "en qué se fue la plata"; esto responde "y cuándo".
 * Apilado y no líneas superpuestas porque las partes suman un todo: la altura
 * total de cada día ES la facturación de ese día, y cada franja es su
 * pedazo. Mismos colores que la torta a propósito — un color significa lo
 * mismo en los dos gráficos.
 *
 * La ganancia neta va abajo, apoyada en el eje: es la franja que el vendedor
 * mira, y la única que se lee sin tener que restar dos alturas.
 */
const STACK_SERIES = [
  { key: "netProfit", name: "Ganancia neta", color: "var(--positive)" },
  { key: "cost", name: "Costo de producto", color: "var(--chart-cost)" },
  { key: "commission", name: "Comisión ML", color: "var(--chart-commission)" },
  { key: "shipping", name: "Envío", color: "var(--chart-shipping)" },
  { key: "iva", name: "IVA", color: "var(--chart-iva)" },
  { key: "ads", name: "Publicidad", color: "var(--chart-ads)" },
] as const;

/**
 * Reemplaza el tooltip automático de Recharts (formatter + contentStyle):
 * con muchos días sin ninguna venta —esta app no rellena esos huecos, el
 * gráfico salta directo al próximo día CON datos— el tooltip por defecto a
 * veces mostraba el día pero ninguna fila con el detalle. Armar el
 * contenido a mano garantiza que siempre liste las seis franjas y el total,
 * que es justamente lo que hay que ver acá.
 */
function StackedAreaTooltip({ active, payload, label }: any) {
  if (!active || !payload || payload.length === 0) return null;
  const total = payload.reduce((sum: number, p: any) => sum + (Number(p.value) || 0), 0);
  return (
    <div
      style={{
        background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8,
        padding: "8px 12px", fontSize: 12, minWidth: 220,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 6 }}>{label}</div>
      {payload.map((p: any) => {
        // Recharts saca el color de "stroke", no de "fill": acá el stroke es
        // var(--surface) a propósito (el borde entre franjas), así que
        // p.color quedaba igual al fondo del tooltip — texto blanco sobre
        // blanco, invisible pero presente en el DOM (por eso nunca se veía
        // ninguna fila, aunque el total sí se calculaba bien). Se busca el
        // color real en STACK_SERIES en vez de confiar en p.color.
        const serie = STACK_SERIES.find((s) => s.key === p.dataKey);
        const value = Number(p.value) || 0;
        const share = total > 0 ? (value / total) * 100 : 0;
        return (
          <div key={p.dataKey} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, padding: "2px 0" }}>
            <span style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--text)" }}>
              <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: 2, background: serie?.color ?? "var(--text-dim)", flexShrink: 0 }} />
              {p.name}
            </span>
            <span style={{ color: "var(--text-dim)", fontVariantNumeric: "tabular-nums" }}>
              {fmt(value)} · {share.toFixed(0)}%
            </span>
          </div>
        );
      })}
      <div
        style={{
          display: "flex", justifyContent: "space-between", gap: 16, marginTop: 6, paddingTop: 6,
          borderTop: "1px solid var(--border)", fontWeight: 600,
        }}
      >
        <span>Total facturado</span>
        <span>{fmt(total)}</span>
      </div>
    </div>
  );
}

function RevenueStackedArea({ daily }: { daily: DailyBreakdown[] }) {
  // "Otros impuestos" se suma a IVA en vez de ser su propia franja: casi
  // siempre es cero y una franja de altura cero es ruido con leyenda.
  const data = daily.map((d) => ({ ...d, iva: d.iva + d.tax }));
  const hasTax = daily.some((d) => d.tax > 0);

  return (
    <div className="chart-card">
      <div className="chart-card-head">
        <h3 className="chart-card-title">Cómo se repartió la facturación, día a día</h3>
        <span className="field-hint" style={{ margin: 0 }}>La altura es lo que facturaste; la franja verde de abajo, lo que te quedó</span>
      </div>
      <ResponsiveContainer width="100%" height={300}>
        <AreaChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
          <CartesianGrid stroke="var(--border)" vertical={false} />
          <XAxis dataKey="day" tick={{ fontSize: 11, fill: "var(--text-dim)" }} tickLine={false} axisLine={false} minTickGap={24} />
          <YAxis tick={{ fontSize: 11, fill: "var(--text-dim)" }} tickLine={false} axisLine={false} width={78} tickFormatter={(v) => fmt(Number(v))} />
          <Tooltip content={<StackedAreaTooltip />} />
          <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8 }} iconType="square" />
          {STACK_SERIES.map((serie) => (
            <Area
              key={serie.key}
              type="monotone"
              dataKey={serie.key}
              name={serie.key === "iva" && hasTax ? "IVA y otros impuestos" : serie.name}
              stackId="facturacion"
              fill={serie.color}
              // El borde del color de la superficie deja 2px de aire entre
              // franjas: sin eso, dos colores contiguos se leen como uno.
              stroke="var(--surface)"
              strokeWidth={2}
              fillOpacity={1}
              isAnimationActive={false}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

const PERIOD_STATUS_LABEL: Record<string, string> = { OPEN: "En curso", CLOSED: "Cerrado" };

/**
 * "Facturas vencidas": lo único confirmado de la API de facturación de ML es
 * si un período está OPEN o CLOSED y su monto — no si está pagado. Se suma
 * una sonda de un endpoint de restricciones que no está oficialmente
 * documentado; si no da una respuesta reconocible, se dice explícitamente
 * que no se pudo confirmar en vez de mostrar "todo bien" sin sustento.
 */
function BillingStatusPanel({ sideContent }: { sideContent?: ReactNode }) {
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    fetch("/api/billing/status")
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        setStatus(await r.json());
      })
      .catch(() => setError(true));
  }, []);

  const hasBillingCard = !error && status && !(status.periods.length === 0 && !status.restrictions.confirmed);

  if (!hasBillingCard) {
    // Sin tabla de facturación para mostrar (todavía cargando, sin permiso,
    // o cuenta sin historial en ML todavía) — las tarjetas de al lado no
    // dependen de esto, así que igual se muestran, solo que en su propia fila.
    return sideContent ? <div className="kpi-grid kpi-grid-3">{sideContent}</div> : null;
  }

  return (
    <>
      <h2 className="section-title">Estado de facturación con Mercado Libre</h2>
      <div style={{ display: "flex", gap: "var(--space-3)", flexWrap: "wrap", alignItems: "flex-start" }}>
      <div className="day-card" style={{ flex: "1 1 420px", maxWidth: 620 }}>
        {status.restrictions.confirmed ? (
          <p className="field-hint" style={{ marginTop: 0 }}>
            {status.restrictions.activeRestrictions === 0
              ? "Mercado Libre no reporta restricciones activas en tu cuenta por facturación."
              : `Mercado Libre reporta ${status.restrictions.activeRestrictions} restricción(es) activa(s) en tu cuenta. Revisá tu Mercado Pago para más detalle.`}
          </p>
        ) : (
          <p className="field-hint" style={{ marginTop: 0 }}>
            No pudimos confirmar directamente si tenés restricciones por deuda de facturación — Mercado Libre no
            expone ese dato de forma estable todavía. Si te preocupa, revisá tu cuenta de Mercado Pago.
          </p>
        )}
        {status.periods.length > 0 && (
          <div className="table-wrap" style={{ marginTop: "var(--space-3)" }}>
            <table>
              <thead>
                <tr>
                  <th>Período</th>
                  <th>Estado</th>
                  <th className="num">Monto</th>
                </tr>
              </thead>
              <tbody>
                {status.periods.map((p) => (
                  <tr key={p.key}>
                    <td>{p.dateFrom ?? p.key} — {p.dateTo ?? ""}</td>
                    <td>
                      {/* Ninguno de los dos estados significa "pagado" —
                          "badge-paid" (verde) daría esa impresión falsa, así
                          que los dos usan el mismo estilo neutro. */}
                      <span className="badge badge-other">
                        {p.periodStatus ? PERIOD_STATUS_LABEL[p.periodStatus] ?? p.periodStatus : "—"}
                      </span>
                    </td>
                    <td className="num">{fmt(p.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="field-hint" style={{ marginBottom: 0, marginTop: "var(--space-3)" }}>
          "Cerrado" es un período que ML ya facturó, no necesariamente uno que quedó sin pagar: el cobro es
          automático contra tu saldo de Mercado Pago.
        </p>
      </div>
      {sideContent && (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)", flex: "1 1 260px", minWidth: 220 }}>
          {sideContent}
        </div>
      )}
      </div>
    </>
  );
}

/**
 * En celular, la fecha completa ("10/09/2026, 11:33 p. m.") es lo que más
 * ancho le saca a la tabla de órdenes — con día y mes alcanza para no tener
 * que desplazar de costado, y el orden cronológico ya lo da la lista.
 */
function useIsNarrowScreen() {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 640px)");
    const update = () => setNarrow(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return narrow;
}

export default function HomePage() {
  const isNarrowScreen = useIsNarrowScreen();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [orders, setOrders] = useState<OrderSummaryRow[] | null>(null);
  const [daily, setDaily] = useState<DailyBreakdown[] | null>(null);
  const [products, setProducts] = useState<ProductRow[] | null>(null);
  const [billing, setBilling] = useState<Billing | null>(null);
  const [period, setPeriod] = useState<Period>("hoy");
  const [customFrom, setCustomFrom] = useState(toDateStr(new Date()));
  const [customTo, setCustomTo] = useState(toDateStr(new Date()));
  const [mlConnected, setMlConnected] = useState<boolean | null>(null);
  const [noAccount, setNoAccount] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [expandedOrder, setExpandedOrder] = useState<string | null>(null);
  const [orderDetails, setOrderDetails] = useState<Record<string, OrderLineDetail[] | "loading" | "error">>({});
  const [unansweredQuestions, setUnansweredQuestions] = useState<number | null>(null);

  function toggleOrder(order: OrderSummaryRow) {
    if (expandedOrder === order.orderId) {
      setExpandedOrder(null);
      return;
    }
    setExpandedOrder(order.orderId);
    if (orderDetails[order.orderId]) return;
    setOrderDetails((prev) => ({ ...prev, [order.orderId]: "loading" }));
    // El detalle de una orden puntual no depende del rango elegido arriba —
    // se pide con la fecha exacta de esa orden, así siempre entra sea cual
    // sea el período que esté mirando la tabla.
    const day = order.dateCreated.slice(0, 10);
    fetch(`/api/orders?orderId=${order.orderId}&from=${day}&to=${day}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        const detail = (await r.json()) as OrderLineDetail[];
        setOrderDetails((prev) => ({ ...prev, [order.orderId]: detail }));
      })
      .catch(() => setOrderDetails((prev) => ({ ...prev, [order.orderId]: "error" })));
  }

  const { from, to } = rangeForPeriod(period, customFrom, customTo);

  // Si una llamada falla (red caída, error del servidor, etc.) esto evita que
  // la sección se quede en "Cargando…" para siempre: se resuelve al valor de
  // respaldo y se muestra un aviso arriba.
  function safeFetch<T>(url: string, onSuccess: (data: T) => void, fallback: T) {
    fetch(url)
      .then(async (r) => {
        if (r.status === 401) { setNoAccount(true); return; }
        if (!r.ok) throw new Error(`${r.status}`);
        onSuccess((await r.json()) as T);
      })
      .catch(() => {
        setLoadError("Algunos datos no se pudieron cargar. Probá recargar la página.");
        onSuccess(fallback);
      });
  }

  function loadAll() {
    setLoadError("");
    safeFetch<Summary | null>(`/api/summary?from=${from}&to=${to}`, setSummary, null);
    safeFetch<DailyBreakdown[]>(`/api/summary?groupBy=day&from=${from}&to=${to}`, setDaily, []);
    safeFetch<OrderSummaryRow[]>(`/api/orders?groupBy=order&from=${from}&to=${to}`, setOrders, []);
    safeFetch<ProductRow[]>(`/api/products?from=${from}&to=${to}`, setProducts, []);
    safeFetch<Billing | null>(`/api/billing?from=${from}&to=${to}`, setBilling, null);
  }

  useEffect(loadAll, [from, to]);
  useEffect(() => {
    fetch("/api/account/me").then((r) => {
      if (r.status === 401) { setNoAccount(true); return; }
      r.json().then((data) => setMlConnected(Boolean(data.mlConnected)));
    });
  }, []);
  // Preguntas sin responder: no depende del período elegido arriba (son las
  // que hay ahora, no las de un rango de fechas), así que se pide una sola
  // vez al entrar. Si falla, queda en "-" sin disparar el aviso general de
  // error: es un dato extra, no algo de lo que dependa el resto de la página.
  useEffect(() => {
    fetch("/api/questions")
      .then(async (r) => {
        if (!r.ok) return;
        const rows = await r.json();
        setUnansweredQuestions(Array.isArray(rows) ? rows.length : 0);
      })
      .catch(() => {});
  }, []);

  if (noAccount) {
    return (
      <div>
        <h1>Resumen de cuenta</h1>
        <NoAccountState />
      </div>
    );
  }

  return (
    <div>
      <h1>Resumen de cuenta</h1>
      {mlConnected === false && (
        <p className="missing-cost">
          Todavía no conectaste Mercado Libre. <a href="/api/ml/login">Conectar ahora</a>
        </p>
      )}
      {loadError && <p className="field-error" role="alert">{loadError}</p>}
      {summary?.pendingMigrations && summary.pendingMigrations.length > 0 && (
        <div className="migration-banner" role="alert">
          <strong>Falta correr una migración en la base.</strong> Los impuestos por producto no se
          están guardando ni mostrando hasta que corras esto en el SQL Editor de Supabase:
          <pre>{summary.pendingMigrations.join("\n")}</pre>
        </div>
      )}
      <SyncButton />

      <PeriodBar
        period={period}
        onPeriodChange={setPeriod}
        customFrom={customFrom}
        customTo={customTo}
        onCustomFromChange={setCustomFrom}
        onCustomToChange={setCustomTo}
      />

      <p
        className="field-hint"
        style={{ margin: "var(--space-2) 0 0", textAlign: "right", display: "flex", gap: "var(--space-3)", justifyContent: "flex-end", flexWrap: "wrap" }}
      >
        <a href={`/api/export/orders?from=${from}&to=${to}`}>
          Descargar detalle del período (CSV)
        </a>
        <a href="/api/export/financial-statement">
          Descargar estado financiero (Excel)
        </a>
      </p>

      <h2 className="section-title">Tienda</h2>
      {summary === null ? (
        <KpiSkeleton />
      ) : (
      <div className="kpi-grid">
        <div className="kpi-card kpi-hero">
          <div className="kpi-card-head"><KpiIcon name="gross" /><span className="label">Facturación</span><KpiInfo>Suma de precio × cantidad de todo lo vendido, antes de descontar nada. Las órdenes canceladas no cuentan.</KpiInfo></div>
          <div className="value"><KpiValue>{summary ? fmt(summary.grossSales) : "-"}</KpiValue></div>
          {summary && <DeltaPill current={summary.grossSales} previous={summary.previous?.grossSales} />}
        </div>
        <div className="kpi-card">
          <div className="kpi-card-head"><KpiIcon name="orders" /><span className="label">Órdenes</span><KpiInfo>Cantidad de órdenes con al menos una venta en el período elegido, sin contar las canceladas.</KpiInfo></div>
          <div className="value"><KpiValue>{summary?.orders ?? "-"}</KpiValue></div>
          {summary && <DeltaPill current={summary.orders} previous={summary.previous?.orders} />}
        </div>
        <div className="kpi-card">
          <div className="kpi-card-head"><KpiIcon name="refund" /><span className="label">Devoluciones</span><KpiInfo>Plata de órdenes canceladas. No suma a la facturación ni a la ganancia —la venta se cayó— pero se muestra para que veas cuánto se te va por ahí.</KpiInfo></div>
          <div className="value"><KpiValue>{summary ? fmt(summary.refundAmount) : "-"}</KpiValue></div>
          {summary && (
            <div className="kpi-delta">
              <span className="kpi-delta-caption">
                {summary.refundOrders} orden(es) · {(summary.refundRate * 100).toLocaleString("es-AR", { maximumFractionDigits: 1 })}% de tus ventas
              </span>
            </div>
          )}
        </div>
        <div className="kpi-card">
          <div className="kpi-card-head"><KpiIcon name="aov" /><span className="label">Ticket promedio</span><KpiInfo>Facturación ÷ Órdenes. Cuánto gasta en promedio cada comprador.</KpiInfo></div>
          <div className="value"><KpiValue>{summary ? fmt(summary.aov) : "-"}</KpiValue></div>
        </div>
        <div className="kpi-card">
          <div className="kpi-card-head"><KpiIcon name="profit" /><span className="label">Ganancia neta</span><KpiInfo>Facturación − comisión de Mercado Libre − envío − publicidad − costo del producto − IVA − otros impuestos. Si a un producto le falta el costo cargado, sus ventas quedan afuera de este número: no se inventa un valor.</KpiInfo></div>
          <div className="value"><KpiValue>{summary ? fmt(summary.netProfit) : "-"}</KpiValue></div>
          {summary && <DeltaPill current={summary.netProfit} previous={summary.previous?.netProfit} />}
        </div>
        <div className="kpi-card">
          <div className="kpi-card-head"><KpiIcon name="margin" /><span className="label">Margen neto</span><KpiInfo>Ganancia neta ÷ Facturación. De cada $100 que facturás, cuánto te queda de verdad.</KpiInfo></div>
          <div className="value"><KpiValue>{summary ? pct(summary.profitPct) : "-"}</KpiValue></div>
        </div>
        <div className="kpi-card">
          <div className="kpi-card-head"><KpiIcon name="net" /><span className="label">Facturación neta</span><KpiInfo>Facturación − comisión de Mercado Libre − envío. No descuenta el costo del producto ni los impuestos.</KpiInfo></div>
          <div className="value"><KpiValue>{summary ? fmt(summary.netRevenue) : "-"}</KpiValue></div>
        </div>
        <div className="kpi-card">
          <div className="kpi-card-head"><KpiIcon name="ads" /><span className="label">Costos en Ads</span><KpiInfo>Lo que gastaste en publicidad en el período: Mercado Ads más lo que cargaste a mano de Meta, Google o TikTok. Ya está descontado de la Ganancia neta. Detalle por campaña en <a href="/campanas">Campañas</a>.</KpiInfo></div>
          <div className="value"><KpiValue>{summary ? fmt(summary.adSpend) : "-"}</KpiValue></div>
        </div>
      </div>
      )}

      {summary && summary.itemsMissingCost > 0 && (
        <MissingCostPanel
          items={summary.itemsMissingCost}
          products={summary.productsMissingCost ?? []}
        />
      )}

      <h2 className="section-title">Rendimiento</h2>
      {daily === null ? (
        <>
          <ChartSkeleton height={260} />
          <div className="chart-split-even">
            <ChartSkeleton height={220} />
            <ChartSkeleton height={220} />
          </div>
        </>
      ) : daily.length === 0 ? (
        <div className="empty-state">
          <p style={{ margin: 0, fontWeight: 600, color: "var(--text)" }}>Sin ventas en este período.</p>
          <p style={{ margin: "var(--space-2) 0 0" }}>Probá con un período más largo — &quot;Este mes&quot; o &quot;Este año&quot;.</p>
        </div>
      ) : (
        <>
          <RevenueStackedArea daily={daily} />
          <div className="chart-split-even">
            <TopProductsCard rows={products ?? []} />
            <RevenueSplitPie daily={daily} />
          </div>
        </>
      )}


      {billing?.available && billing.buckets.length > 0 && (
        <>
          <h2 className="section-title">Lo que Mercado Libre te facturó</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Concepto</th>
                  <th className="num">Importe</th>
                  <th className="num">Lo que calculamos</th>
                </tr>
              </thead>
              <tbody>
                {billing.buckets.map((b) => {
                  // Solo comisión y envío son comparables: son los dos cargos
                  // que la app también estima por orden.
                  const estimated =
                    b.bucket === "comision" ? summary?.totalCommission :
                    b.bucket === "envio" ? summary?.totalShipping : undefined;
                  return (
                    <tr key={b.bucket}>
                      <td>{b.label}</td>
                      <td className="num">{fmt(b.amount)}</td>
                      <td className="num" style={{ color: "var(--text-dim)" }}>
                        {estimated === undefined ? "—" : fmt(estimated)}
                      </td>
                    </tr>
                  );
                })}
                <tr>
                  <td style={{ fontWeight: 600 }}>Total facturado por ML</td>
                  <td className="num" style={{ fontWeight: 600 }}>{fmt(billing.total)}</td>
                  <td className="num">—</td>
                </tr>
              </tbody>
            </table>
          </div>
          {billing.commissionCheck && (() => {
            const verdict = interpretCommissionCheck(billing.commissionCheck);
            return (
              <div className={verdict.status === "ok" ? "check-box check-ok" : "check-box check-warn"} role="status">
                <strong>{verdict.status === "ok" ? "✓ " : "⚠ "}{verdict.title}</strong>
                <p>{verdict.detail}</p>
              </div>
            );
          })()}
          <details className="explain-box">
            <summary>¿Qué es esta tabla?</summary>
            <p>
              Son los cargos <strong>reales</strong> de tu factura de Mercado Libre, traídos de su API de
              facturación: comisiones, envíos, percepciones impositivas y publicidad. El resto del dashboard
              estima estos costos venta por venta; acá ves lo que ML efectivamente te cobró, para poder
              comparar.
            </p>
            <p>
              Todavía <strong>no</strong> entran en la ganancia neta: la comisión y el envío ya se descuentan
              por orden, así que sumarlos otra vez los contaría dos veces. Si los números de las dos columnas
              no cierran, avisanos y ajustamos el cálculo.
            </p>
          </details>
        </>
      )}

      <BillingStatusPanel
        sideContent={
          <>
            <div className="kpi-card">
              <div className="kpi-card-head">
                <KpiIcon name="visits" /><span className="label">Visitas a la tienda</span>
                <KpiInfo>
                  Cuánta gente entró a ver tus publicaciones en el período elegido arriba, según Mercado Libre.
                  Debajo va la conversión: de cada 100 visitas, cuántas terminaron en venta.
                </KpiInfo>
              </div>
              <div className="value">
                <KpiValue>{summary ? (summary.visits === null ? "Sin dato" : summary.visits.toLocaleString("es-AR")) : "-"}</KpiValue>
              </div>
              {summary?.conversionRate != null && (
                <div className="kpi-delta">
                  <span className="kpi-delta-caption">
                    {(summary.conversionRate * 100).toLocaleString("es-AR", { maximumFractionDigits: 2 })}% de conversión
                  </span>
                </div>
              )}
            </div>
            <div className="kpi-card">
              <div className="kpi-card-head">
                <KpiIcon name="question" /><span className="label">Preguntas sin responder</span>
                <KpiInfo>Consultas de compradores en Mercado Libre que todavía no tienen respuesta enviada. Se responden en <a href="/consultas">Consultas</a>.</KpiInfo>
              </div>
              <div className="value"><KpiValue>{unansweredQuestions === null ? "-" : unansweredQuestions}</KpiValue></div>
            </div>
            <div className="kpi-card">
              <div className="kpi-card-head">
                <KpiIcon name="lossAlert" /><span className="label">Vendiendo a pérdida</span>
                <KpiInfo>Productos cuya ganancia neta real promedio por unidad vendida es negativa (con comisión, envío e impuestos ya descontados). Detalle en <a href="/productos">Productos</a>.</KpiInfo>
              </div>
              <div className="value">
                <KpiValue>{products === null ? "-" : products.filter((p) => p.negativeMargin).length}</KpiValue>
              </div>
            </div>
          </>
        }
      />

      <h2 className="section-title">Últimas órdenes</h2>
      {orders && orders.length === 0 ? (
        <div className="empty-state">
          <p style={{ margin: 0, fontWeight: 600, color: "var(--text)" }}>Sin órdenes en este período.</p>
          <p style={{ margin: "var(--space-2) 0 0" }}>Cambiá el período de arriba o sincronizá para traer ventas nuevas.</p>
        </div>
      ) : (
        <div className="table-wrap table-scroll orders-table">
          <table>
            <thead>
              <tr>
                <th>N° de orden</th>
                <th>Estado</th>
                <th>Fecha</th>
                <th className="num">Total</th>
                <th className="num">Neto</th>
              </tr>
            </thead>
            <tbody>
              {(orders ?? []).map((o) => (
                <Fragment key={o.orderId}>
                  <tr
                    onClick={() => toggleOrder(o)}
                    style={{ cursor: "pointer" }}
                    aria-expanded={expandedOrder === o.orderId}
                  >
                    <td className="order-id">
                      <span aria-hidden="true" style={{ display: "inline-block", marginRight: 4, transform: expandedOrder === o.orderId ? "rotate(90deg)" : undefined, transition: "transform var(--duration-fast) var(--ease-out)" }}>
                        ›
                      </span>
                      {o.orderId}
                    </td>
                    <td>
                      <span className={`badge ${estadoBadgeClass(o.estadoPago)}`}>{estadoLabel(o.estadoPago)}</span>
                    </td>
                    <td>
                      {isNarrowScreen
                        ? new Date(o.dateCreated).toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit" })
                        : new Date(o.dateCreated).toLocaleString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })}
                    </td>
                    <td className="num" style={countsAsRevenue(o.estadoPago) ? undefined : { color: "var(--text-dim)", textDecoration: "line-through" }}>{fmt(o.totalOrder)}</td>
                    {/* Una orden cancelada no dejó ganancia: mostrar su neto en
                        verde como si fuera plata ganada era directamente falso. */}
                    <td className="num" style={countsAsRevenue(o.estadoPago) ? { color: o.totalNeto >= 0 ? "var(--positive)" : "var(--negative)", fontWeight: 600 } : { color: "var(--text-dim)" }}>
                      {countsAsRevenue(o.estadoPago) ? fmt(o.totalNeto) : "—"}
                    </td>
                  </tr>
                  {expandedOrder === o.orderId && (
                    <tr>
                      <td colSpan={5} style={{ padding: 0, background: "var(--bg)" }}>
                        <OrderReceipt items={orderDetails[o.orderId] ?? "loading"} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
