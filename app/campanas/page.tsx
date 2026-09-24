"use client";

import { useEffect, useState } from "react";
import {
  ResponsiveContainer, AreaChart, Area, ComposedChart, Bar, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from "recharts";
import { NoAccountState } from "../NoAccountState";
import { PeriodBar } from "../PeriodBar";
import { Period, rangeForPeriod, toDateStr } from "@/lib/period";

interface Summary {
  adSpend: number;
  mer: number;
  roas: number;
  cpa: number;
  netAov: number;
  trueCpa: number;
  netProfit: number;
}

interface DailyAdsRow {
  day: string;
  ads: number;
  netProfit: number;
}

interface Campaign {
  id: string;
  name: string;
  status: string;
  budget: number;
}

interface AdsProductPerformance {
  productId: string;
  title: string;
  revenue: number;
  adSpend: number;
  netProfit: number;
  roas: number | null;
  recommendation: "pausar" | "mantener" | "aumentar";
  acos: number | null;
  breakevenAcos: number | null;
  maxAdSpend: number;
}

const RECOMMENDATION_LABEL: Record<AdsProductPerformance["recommendation"], string> = {
  pausar: "Pausar",
  mantener: "Mantener",
  aumentar: "Aumentar",
};

const RECOMMENDATION_BADGE: Record<AdsProductPerformance["recommendation"], string> = {
  pausar: "badge-cancelled",
  mantener: "badge-other",
  aumentar: "badge-paid",
};

function fmt(n: number) {
  return n.toLocaleString("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 });
}

function pct(n: number | null) {
  return n === null ? "—" : `${(n * 100).toFixed(1)}%`;
}

/**
 * Tooltip a medida: con el default de Recharts, un día sin ninguna venta
 * (esta app no rellena huecos) a veces mostraba la fecha sin ninguna fila de
 * detalle abajo — mismo problema que en el gráfico de facturación diaria del
 * Resumen. Se arma a mano para garantizar que siempre se vean las dos series.
 */
function AdsProfitTooltip({ active, payload, label }: any) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div
      style={{
        background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8,
        padding: "8px 12px", fontSize: 12, minWidth: 180,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 6 }}>{label}</div>
      {payload.map((p: any) => (
        <div key={p.dataKey} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, padding: "2px 0" }}>
          <span style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--text)" }}>
            <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: 2, background: p.dataKey === "ads" ? "var(--chart-ads)" : "var(--positive)", flexShrink: 0 }} />
            {p.name}
          </span>
          <span style={{ color: "var(--text-dim)", fontVariantNumeric: "tabular-nums" }}>{fmt(Number(p.value) || 0)}</span>
        </div>
      ))}
    </div>
  );
}

function KpiValue({ children }: { children: React.ReactNode }) {
  if (children === "-") return <span className="skeleton" aria-hidden="true" />;
  return <>{children}</>;
}

/** El ⓘ de cada tarjeta con la explicación de esa métrica. */
function KpiInfo({ children }: { children: React.ReactNode }) {
  return (
    <details className="kpi-info">
      <summary aria-label="Cómo se calcula">i</summary>
      <div className="kpi-info-panel">{children}</div>
    </details>
  );
}

export default function CampanasPage() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [daily, setDaily] = useState<DailyAdsRow[] | null>(null);
  const [adForm, setAdForm] = useState({ channel: "meta", date: new Date().toISOString().slice(0, 10), amount: "" });
  const [adFormError, setAdFormError] = useState("");
  const [adFormSuccess, setAdFormSuccess] = useState(false);
  const [period, setPeriod] = useState<Period>("mes");
  const [customFrom, setCustomFrom] = useState(toDateStr(new Date()));
  const [customTo, setCustomTo] = useState(toDateStr(new Date()));
  const [noAccount, setNoAccount] = useState(false);
  const [campaigns, setCampaigns] = useState<Campaign[] | null>(null);
  const [campaignsError, setCampaignsError] = useState("");
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [adsPerformance, setAdsPerformance] = useState<AdsProductPerformance[] | null>(null);

  const { from, to } = rangeForPeriod(period, customFrom, customTo);
  const activeCampaigns = campaigns?.filter((c) => c.status === "active").length ?? 0;

  function load() {
    fetch(`/api/summary?from=${from}&to=${to}`).then((r) => {
      if (r.status === 401) { setNoAccount(true); return; }
      r.json().then(setSummary);
    });
    fetch(`/api/summary?groupBy=day&from=${from}&to=${to}`).then((r) => {
      if (r.status === 401) return;
      r.json().then(setDaily);
    });
    fetch(`/api/campaigns/products?from=${from}&to=${to}`).then((r) => {
      if (r.status === 401) return;
      r.json().then(setAdsPerformance);
    });
  }

  function loadCampaigns() {
    setCampaignsError("");
    fetch("/api/campaigns").then(async (r) => {
      if (r.status === 401) { setNoAccount(true); return; }
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        setCampaignsError(data.error ?? "No se pudieron cargar las campañas.");
        setCampaigns([]);
        return;
      }
      r.json().then(setCampaigns);
    });
  }

  useEffect(load, [from, to]);
  useEffect(loadCampaigns, []);

  async function toggleCampaign(campaignId: string, currentStatus: string) {
    const nextStatus = currentStatus === "active" ? "paused" : "active";
    setTogglingId(campaignId);
    try {
      const res = await fetch("/api/campaigns", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campaignId, status: nextStatus }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setCampaignsError(data.error ?? "No se pudo cambiar el estado de la campaña.");
        return;
      }
      loadCampaigns();
    } finally {
      setTogglingId(null);
    }
  }

  if (noAccount) {
    return (
      <div>
        <h1>Campañas</h1>
        <NoAccountState />
      </div>
    );
  }

  async function submitAdSpend(e: React.FormEvent) {
    e.preventDefault();
    setAdFormError("");
    setAdFormSuccess(false);
    const amount = Number(adForm.amount);
    if (adForm.amount.trim() === "" || Number.isNaN(amount) || amount < 0) {
      setAdFormError("Ingresá un monto válido (mayor o igual a 0).");
      return;
    }
    await fetch("/api/ads-spend", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel: adForm.channel, date: adForm.date, amount }),
    });
    setAdForm((prev) => ({ ...prev, amount: "" }));
    setAdFormSuccess(true);
    load();
  }

  return (
    <div>
      <h1>Campañas</h1>

      <PeriodBar
        period={period}
        onPeriodChange={setPeriod}
        customFrom={customFrom}
        customTo={customTo}
        onCustomFromChange={setCustomFrom}
        onCustomToChange={setCustomTo}
      />

      <h2 className="section-title">Anuncios</h2>
      <div className="kpi-grid">
        <div className="kpi-card">
          <div className="kpi-card-head"><span className="label">Ad Spend</span><KpiInfo>Lo que gastaste en total en publicidad en el período: Mercado Ads más lo que cargaste a mano de Meta, Google o TikTok.</KpiInfo></div>
          <div className="value"><KpiValue>{summary ? fmt(summary.adSpend) : "-"}</KpiValue></div>
        </div>
        <div className="kpi-card">
          <div className="kpi-card-head"><span className="label">MER</span><KpiInfo>Facturación ÷ Gasto en Ads. Cuántos pesos facturaste por cada peso que invertiste en publicidad.</KpiInfo></div>
          <div className="value"><KpiValue>{summary ? summary.mer.toFixed(2) : "-"}</KpiValue></div>
        </div>
        <div className="kpi-card">
          <div className="kpi-card-head"><span className="label">ROAS</span><KpiInfo>Hoy se calcula igual que MER: Mercado Libre no separa qué parte de la facturación vino puntualmente de un anuncio, así que no hay forma de aislar el retorno solo de las ventas por Ads.</KpiInfo></div>
          <div className="value"><KpiValue>{summary ? summary.roas.toFixed(2) : "-"}</KpiValue></div>
        </div>
        <div className="kpi-card">
          <div className="kpi-card-head"><span className="label">CPA</span><KpiInfo>Gasto en Ads ÷ Cantidad de órdenes del período. Cuánto costó, en promedio, cada orden — le atribuyas o no esa orden puntual a un anuncio.</KpiInfo></div>
          <div className="value"><KpiValue>{summary ? fmt(summary.cpa) : "-"}</KpiValue></div>
        </div>
        <div className="kpi-card">
          <div className="kpi-card-head"><span className="label">Net AOV</span><KpiInfo>Ganancia neta ÷ Órdenes. La ganancia real que te deja, en promedio, cada orden.</KpiInfo></div>
          <div className="value"><KpiValue>{summary ? fmt(summary.netAov) : "-"}</KpiValue></div>
        </div>
        <div className="kpi-card">
          <div className="kpi-card-head"><span className="label">True CPA</span><KpiInfo>Gasto en Ads ÷ Órdenes que ya tienen costo cargado. Igual que CPA pero solo sobre las órdenes con ganancia real calculada, para no subestimar el costo por orden cuando todavía falta cargar costos.</KpiInfo></div>
          <div className="value"><KpiValue>{summary ? fmt(summary.trueCpa) : "-"}</KpiValue></div>
        </div>
        <div className="kpi-card">
          <div className="kpi-card-head"><span className="label">Campañas activas</span><KpiInfo>Cantidad de campañas de Mercado Ads corriendo ahora mismo. No cuenta las pausadas.</KpiInfo></div>
          <div className="value"><KpiValue>{campaigns ? String(activeCampaigns) : "-"}</KpiValue></div>
        </div>
        <div className="kpi-card">
          <div className="kpi-card-head"><span className="label">Ganancia neta</span><KpiInfo>Ganancia neta del período completo (ya descontando comisión, envío, publicidad, costo e impuestos) — para comparar de un vistazo contra el Ad Spend de arriba.</KpiInfo></div>
          <div className="value"><KpiValue>{summary ? fmt(summary.netProfit) : "-"}</KpiValue></div>
        </div>
      </div>

      <h2 className="section-title">Gasto en Ads y su efecto en la ganancia</h2>
      <div className="chart-split-even">
        <div className="chart-card">
          <div className="chart-card-head">
            <h3 className="chart-card-title">Gasto en Ads, día a día</h3>
          </div>
          {daily && daily.every((d) => d.ads === 0) ? (
            <p className="empty-state">Sin gasto en publicidad en este período.</p>
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <AreaChart data={daily ?? []} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
                <CartesianGrid stroke="var(--border)" vertical={false} />
                <XAxis dataKey="day" tick={{ fontSize: 11, fill: "var(--text-dim)" }} tickLine={false} axisLine={false} minTickGap={24} />
                <YAxis tick={{ fontSize: 11, fill: "var(--text-dim)" }} tickLine={false} axisLine={false} width={70} tickFormatter={(v) => fmt(Number(v))} />
                <Tooltip content={<AdsProfitTooltip />} />
                <Area type="monotone" dataKey="ads" name="Gasto en Ads" stroke="var(--chart-ads)" fill="var(--chart-ads)" fillOpacity={0.25} strokeWidth={2} isAnimationActive={false} />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
        <div className="chart-card">
          <div className="chart-card-head">
            <h3 className="chart-card-title">Publicidad vs. Ganancia neta</h3>
            <span className="field-hint" style={{ margin: 0 }}>Para ver si los días de más gasto son también los de más ganancia</span>
          </div>
          <ResponsiveContainer width="100%" height={260}>
            <ComposedChart data={daily ?? []} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
              <CartesianGrid stroke="var(--border)" vertical={false} />
              <XAxis dataKey="day" tick={{ fontSize: 11, fill: "var(--text-dim)" }} tickLine={false} axisLine={false} minTickGap={24} />
              <YAxis yAxisId="ads" tick={{ fontSize: 11, fill: "var(--text-dim)" }} tickLine={false} axisLine={false} width={70} tickFormatter={(v) => fmt(Number(v))} />
              <YAxis yAxisId="profit" orientation="right" tick={{ fontSize: 11, fill: "var(--text-dim)" }} tickLine={false} axisLine={false} width={70} tickFormatter={(v) => fmt(Number(v))} />
              <Tooltip content={<AdsProfitTooltip />} />
              <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8 }} iconType="square" />
              <Bar yAxisId="ads" dataKey="ads" name="Gasto en Ads" fill="var(--chart-ads)" isAnimationActive={false} />
              <Line yAxisId="profit" type="monotone" dataKey="netProfit" name="Ganancia neta" stroke="var(--positive)" strokeWidth={2} dot={false} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>

      <h2 className="section-title">Campañas de Mercado Ads</h2>
      {campaignsError && <p className="field-error" role="alert" style={{ marginBottom: "var(--space-3)" }}>{campaignsError}</p>}
      {campaigns === null ? (
        <p className="empty-state">Cargando campañas…</p>
      ) : campaigns.length === 0 && !campaignsError ? (
        <div className="empty-state">
          <p style={{ margin: 0, fontWeight: 600, color: "var(--text)" }}>No tenés campañas de Mercado Ads.</p>
          <p style={{ margin: "var(--space-2) 0 0" }}>
            Cuando crees una campaña de Product Ads en Mercado Libre, va a aparecer acá y vas a poder
            pausarla o reactivarla sin salir del dashboard.
          </p>
        </div>
      ) : campaigns.length > 0 ? (
        <div className="table-wrap table-scroll" style={{ marginBottom: "var(--space-5)" }}>
          <table>
            <thead>
              <tr>
                <th>Campaña</th>
                <th>Estado</th>
                <th className="num">Presupuesto</th>
                <th>Acción</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map((c) => (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td>
                    <span className={`badge ${c.status === "active" ? "badge-paid" : "badge-other"}`}>{c.status}</span>
                  </td>
                  <td className="num">{fmt(c.budget)}</td>
                  <td>
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => toggleCampaign(c.id, c.status)}
                      disabled={togglingId === c.id}
                    >
                      {togglingId === c.id ? "…" : c.status === "active" ? "Pausar" : "Reactivar"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <h2 className="section-title">
        Rendimiento de Ads por publicación
        <KpiInfo>
          Compara la publicidad real que gastó cada publicación contra la ganancia neta que dejó — para decidir a
          cuál seguir pagando, a cuál sacarle presupuesto y a cuál ponerle más plata, no solo mirar el total de la
          cuenta. Solo cubre los últimos ~90 días: es el límite que da Mercado Libre para el gasto por publicación
          puntual, no una limitación nuestra. <strong>Pausar</strong>: la ganancia (ya con Ads descontado) es
          negativa. <strong>Aumentar</strong>: sin publicidad este producto dejaría bastante más que el doble de lo
          que gasta en Ads — hay margen de sobra para invertir más. <strong>Mantener</strong>: da ganancia, pero la
          publicidad ya se lleva una porción grande de esa ganancia.
          <br /><br />
          <strong>ACOS</strong>: publicidad ÷ facturación de la publicación (Mercado Libre no separa qué ventas
          vinieron del anuncio, así que se mide sobre todas). <strong>ACOS de equilibrio</strong>: el máximo ACOS
          que aguanta el producto antes de perder plata, con comisión, envío, costo e impuestos ya descontados. Si
          el ACOS lo supera, cada venta con Ads deja pérdida. <strong>Tope de Ads</strong>: lo máximo que se
          podía gastar en el período sin quedar en rojo.
        </KpiInfo>
      </h2>
      {adsPerformance === null ? (
        <p className="empty-state">Cargando…</p>
      ) : adsPerformance.length === 0 ? (
        <div className="empty-state">
          <p style={{ margin: 0, fontWeight: 600, color: "var(--text)" }}>
            Sin gasto de Ads por publicación en este período.
          </p>
          <p style={{ margin: "var(--space-2) 0 0" }}>
            Puede ser que no hayas usado Ads en estas fechas, o que el período elegido quede fuera de los últimos
            ~90 días (el límite que da Mercado Libre para este dato).
          </p>
        </div>
      ) : (
        <div className="table-wrap table-scroll" style={{ marginBottom: "var(--space-5)" }}>
          <table>
            <thead>
              <tr>
                <th>Producto</th>
                <th className="num">Publicidad</th>
                <th className="num">Facturación</th>
                <th className="num">Ganancia neta</th>
                <th className="num">ACOS</th>
                <th className="num">ACOS de equilibrio</th>
                <th className="num">Tope de Ads</th>
                <th>Recomendación</th>
              </tr>
            </thead>
            <tbody>
              {adsPerformance.map((p) => (
                <tr key={p.productId}>
                  <td>{p.title}</td>
                  <td className="num">{fmt(p.adSpend)}</td>
                  <td className="num">{fmt(p.revenue)}</td>
                  <td className={`num ${p.netProfit < 0 ? "missing-cost" : ""}`}>{fmt(p.netProfit)}</td>
                  <td className={`num ${p.acos !== null && p.breakevenAcos !== null && p.acos > p.breakevenAcos ? "missing-cost" : ""}`}>
                    {pct(p.acos)}
                  </td>
                  <td className="num">
                    {p.breakevenAcos !== null && p.breakevenAcos <= 0 ? (
                      <span className="missing-cost" title="Pierde plata aun sin publicidad: ningún gasto en Ads le sirve.">
                        Sin margen
                      </span>
                    ) : (
                      pct(p.breakevenAcos)
                    )}
                  </td>
                  <td className="num">{fmt(p.maxAdSpend)}</td>
                  <td>
                    <span className={`badge ${RECOMMENDATION_BADGE[p.recommendation]}`}>
                      {RECOMMENDATION_LABEL[p.recommendation]}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2 className="section-title">Cargar publicidad externa</h2>
      <form className="ad-form" onSubmit={submitAdSpend} noValidate>
        <label>
          Canal
          <select value={adForm.channel} onChange={(e) => setAdForm((p) => ({ ...p, channel: e.target.value }))}>
            <option value="meta">Meta</option>
            <option value="google">Google Ads</option>
            <option value="tiktok">TikTok</option>
          </select>
        </label>
        <label>
          Fecha
          <input type="date" value={adForm.date} onChange={(e) => setAdForm((p) => ({ ...p, date: e.target.value }))} />
        </label>
        <div className="field-group">
          <label htmlFor="ad-amount">Monto</label>
          <input
            id="ad-amount"
            type="number"
            min="0"
            inputMode="decimal"
            aria-invalid={adFormError ? true : undefined}
            value={adForm.amount}
            onChange={(e) => {
              setAdForm((p) => ({ ...p, amount: e.target.value }));
              if (adFormError) setAdFormError("");
            }}
          />
          {adFormError && <p className="field-error" role="alert">{adFormError}</p>}
        </div>
        <button type="submit" className="btn btn-primary">Cargar</button>
        {adFormSuccess && (
          <span role="status" aria-live="polite" className="success-text">
            Publicidad cargada.
          </span>
        )}
      </form>
    </div>
  );
}
