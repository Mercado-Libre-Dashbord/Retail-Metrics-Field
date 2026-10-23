"use client";

import { useEffect, useState } from "react";
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip } from "recharts";
import { NoAccountState } from "../NoAccountState";
import { PeriodBar } from "../PeriodBar";
import { Period, rangeForPeriod, toDateStr } from "@/lib/period";
import type { AdsReportResponse } from "@/app/api/campaigns/products/route";
import { ACTION_LABEL, type AdviceAction, type AdvisedProduct } from "@/lib/ads-advisor";

/**
 * Campañas responde una pregunta: ¿dónde conviene poner la plata de
 * publicidad y cuánta? El asesor (lib/ads-advisor.ts) es el bloque principal;
 * los indicadores y el detalle técnico están para respaldarlo.
 */

interface Summary {
  adSpend: number;
  grossSales: number;
  netProfit: number;
}

interface DailyAdsRow {
  day: string;
  ads: number;
}

interface Campaign {
  id: string;
  name: string;
  status: string;
  budget: number;
}

const ACTION_PILL: Record<AdviceAction, string> = {
  pausar: "pill-neg",
  bajar: "pill-neg",
  revisar_precio: "pill-neg",
  subir: "pill-pos",
  probar: "pill-info",
  mantener: "pill-neutral",
  sin_costo: "pill-neutral",
};

const STATUS_LABEL: Record<string, string> = { active: "Activa", paused: "Pausada" };

function fmt(n: number) {
  return n.toLocaleString("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 });
}
function pct(n: number | null) {
  return n === null ? "—" : `${(n * 100).toLocaleString("es-AR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
}
function times(n: number | null) {
  return n === null ? "—" : `${n.toLocaleString("es-AR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}x`;
}
function fmtDate(d: string) {
  const [y, m, day] = d.split("-");
  return `${day}/${m}/${y}`;
}
function shortDay(d: string) {
  const [, m, day] = d.split("-");
  return `${day}/${m}`;
}

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

/** El hallazgo del período, en una frase, armado con los mismos números del asesor. */
function Finding({ report }: { report: AdsReportResponse | null }) {
  const advice = report?.advice;
  if (!report || report.error || !report.available) return null;
  if (!advice || advice.items.length === 0) {
    return <p className="page-finding">Sin actividad de Mercado Ads en este período.</p>;
  }
  const c = advice.counts;
  // Los mismos anuncios que suma monthlyLoss: los que hoy pierden plata.
  const losing = advice.items.filter(
    (i) => (i.action === "pausar" || i.action === "bajar" || i.action === "revisar_precio") && (i.adsProfit ?? 0) < 0
  ).length;
  const parts: React.ReactNode[] = [];
  if (losing > 0) {
    parts.push(
      <span key="cut">
        {plural(losing, "anuncio pierde", "anuncios pierden")} plata: pausarlos o corregirlos te ahorra unos{" "}
        <strong>{fmt(advice.monthlyLoss)} por mes</strong>.{" "}
      </span>
    );
  }
  if ((c.subir ?? 0) > 0) parts.push(<span key="up">{plural(c.subir!, "anuncio deja", "anuncios dejan")} margen para invertir más. </span>);
  if ((c.probar ?? 0) > 0) parts.push(<span key="try">{plural(c.probar!, "publicación sin publicidad es", "publicaciones sin publicidad son")} buenas candidatas. </span>);
  if (parts.length === 0) parts.push(<span key="ok">Ningún anuncio pierde plata: están en un rango sano.</span>);
  return <p className="page-finding">{parts}</p>;
}

function AdviceBudget({ item }: { item: AdvisedProduct }) {
  if (item.suggestedDaily === null) return <span className="from">—</span>;
  if (item.action === "probar") return <span className="to">{fmt(item.suggestedDaily)}/día para empezar</span>;
  if (item.suggestedDaily === 0) return <><span className="from">{fmt(item.currentDaily)}</span><span className="arrow">→</span><span className="to">$0</span></>;
  return (
    <>
      <span className="from">{fmt(item.currentDaily)}</span>
      <span className="arrow">→</span>
      <span className="to">{fmt(item.suggestedDaily)}</span>
      <span className="from">/día</span>
    </>
  );
}

const ADVICE_ROWS = 8;

function AdvicePanel({ report }: { report: AdsReportResponse | null }) {
  const [showAll, setShowAll] = useState(false);
  const head = (meta?: string) => (
    <div className="panel-head">
      <h2>Qué hacer con cada anuncio</h2>
      {meta && <span className="meta">{meta}</span>}
    </div>
  );

  if (report === null) {
    return (
      <section className="panel" aria-busy="true">
        {head()}
        <p className="empty-state">Leyendo el reporte de Mercado Ads…</p>
      </section>
    );
  }
  if (report.error) {
    return (
      <section className="panel">
        {head()}
        <p className="field-error" role="alert" style={{ padding: "0 var(--space-5) var(--space-4)" }}>{report.error}</p>
      </section>
    );
  }
  if (!report.available) {
    return (
      <section className="panel">
        {head()}
        <p className="empty-state">Esta cuenta no tiene Product Ads de Mercado Libre.</p>
      </section>
    );
  }
  const items = report.advice?.items ?? [];
  const period = report.from && report.to ? `${fmtDate(report.from)} al ${fmtDate(report.to)}` : undefined;
  if (items.length === 0) {
    return (
      <section className="panel">
        {head(period)}
        <p className="empty-state">Sin gasto en Mercado Ads ni publicaciones para sugerir en este período.</p>
      </section>
    );
  }
  const shown = showAll ? items : items.slice(0, ADVICE_ROWS);
  return (
    <section className="panel">
      {head(period)}
      <div className="table-flush">
        <table className="advice-table">
          <thead>
            <tr>
              <th>Qué hacer</th>
              <th>Publicación</th>
              <th className="num">Margen que aguanta</th>
              <th className="num">ACOS real</th>
              <th className="num">Ganancia por publicidad</th>
              <th className="num">Gasto por día</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((it) => (
              <tr key={it.productId}>
                <td className="cell-action">
                  <span className={`pill ${ACTION_PILL[it.action]}`}>{ACTION_LABEL[it.action]}</span>
                </td>
                <td>
                  <span className="title">{it.title}</span>
                  <span className="why">{it.reason}</span>
                </td>
                <td className="num" data-label="Margen que aguanta:">
                  {it.breakevenAcos === null ? "—" : it.breakevenAcos <= 0 ? <span className="num-neg">Sin margen</span> : pct(it.breakevenAcos)}
                </td>
                <td className={`num ${it.acos !== null && it.breakevenAcos !== null && it.acos > it.breakevenAcos ? "num-neg" : ""}`} data-label="ACOS real:">
                  {pct(it.acos)}
                </td>
                <td className={`num ${it.adsProfit !== null && it.adsProfit < 0 ? "num-neg" : ""}`} data-label="Ganancia por publicidad:">
                  {it.adsProfit === null ? "—" : fmt(it.adsProfit)}
                </td>
                <td className="num budget" data-label="Gasto por día:">
                  <AdviceBudget item={it} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="panel-foot">
        <span>
          El tope apunta a gastar hasta el 60% del margen de cada producto: así cada venta por publicidad sigue dejando
          ganancia. Cambiá de a poco y volvé a mirar en una semana.
        </span>
        {items.length > ADVICE_ROWS && (
          <button type="button" className="link-btn" onClick={() => setShowAll((v) => !v)}>
            {showAll ? "Ver menos" : `Ver las ${items.length}`}
          </button>
        )}
      </div>
    </section>
  );
}

function DailyAdsTooltip({ active, payload, label }: { active?: boolean; payload?: { value: number }[]; label?: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, padding: "6px 10px", fontSize: 12 }}>
      {label ? shortDay(label) : ""} · <strong>{fmt(Number(payload[0].value) || 0)}</strong>
    </div>
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
  const [adsReport, setAdsReport] = useState<AdsReportResponse | null>(null);

  const { from, to } = rangeForPeriod(period, customFrom, customTo);

  function load() {
    fetch(`/api/summary?from=${from}&to=${to}`).then((r) => {
      if (r.status === 401) { setNoAccount(true); return; }
      r.json().then(setSummary);
    });
    fetch(`/api/summary?groupBy=day&from=${from}&to=${to}`).then((r) => {
      if (r.status === 401) return;
      r.json().then(setDaily);
    });
    setAdsReport(null);
    fetch(`/api/campaigns/products?from=${from}&to=${to}`).then(async (r) => {
      if (r.status === 401) return;
      const data = await r.json().catch(() => null);
      setAdsReport(
        data ?? { available: true, from: null, to: null, clamped: false, error: "No se pudo leer el reporte de Mercado Ads.", totals: null, campaigns: [], products: [] }
      );
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

  const t = adsReport?.totals ?? null;
  const adsProfit = adsReport?.products.reduce<number | null>((s, p) => (p.adsProfit === null ? s : (s ?? 0) + p.adsProfit), null) ?? null;
  const reportByCampaign = new Map((adsReport?.campaigns ?? []).map((c) => [c.id, c]));
  const hasDailyAds = (daily ?? []).some((d) => d.ads > 0);

  return (
    <div>
      <h1>Campañas</h1>
      <Finding report={adsReport} />

      <PeriodBar
        period={period}
        onPeriodChange={setPeriod}
        customFrom={customFrom}
        customTo={customTo}
        onCustomFromChange={setCustomFrom}
        onCustomToChange={setCustomTo}
      />

      <div className="kpi-strip" style={{ ["--kpi-cols" as string]: 4 }}>
        <div>
          <span className="label">Ganancia que dejó la publicidad</span>
          <span className={`value lead ${adsProfit !== null && adsProfit < 0 ? "num-neg" : ""}`}>{adsReport === null ? "…" : adsProfit === null ? "—" : fmt(adsProfit)}</span>
          <span className="sub">ventas por anuncios × margen − lo invertido</span>
        </div>
        <div>
          <span className="label">Invertido en publicidad</span>
          <span className="value">{summary ? fmt(summary.adSpend) : "…"}</span>
          <span className="sub">Mercado Ads y lo cargado de otras redes</span>
        </div>
        <div>
          <span className="label">Vendido por publicidad</span>
          <span className="value">{adsReport === null ? "…" : t ? fmt(t.adRevenue) : "—"}</span>
          <span className="sub">{t ? `${t.adUnits.toLocaleString("es-AR")} u. · ${pct(t.adShare)} de las unidades con anuncio` : "según Mercado Ads"}</span>
        </div>
        <div>
          <span className="label">Retorno (ROAS)</span>
          <span className="value">{adsReport === null ? "…" : t ? times(t.roas) : "—"}</span>
          <span className="sub">{t ? `ACOS ${pct(t.acos)} · ${pct(t.tacos)} de toda tu facturación` : "ventas por anuncios ÷ inversión"}</span>
        </div>
      </div>

      {adsReport?.clamped && adsReport.from && (
        <p className="field-hint" style={{ marginTop: 0 }}>
          Mercado Ads solo guarda los últimos ~90 días: los datos de anuncios arrancan el {fmtDate(adsReport.from)}.
        </p>
      )}

      <AdvicePanel report={adsReport} />

      <div className="split-2">
        <section className="panel panel-fill">
          <div className="panel-head">
            <h2>Gasto en publicidad por día</h2>
            <span className="meta">Mercado Ads y otras redes</span>
          </div>
          <div className="chart-fill">
            {daily === null ? (
              <p className="empty-state">Cargando…</p>
            ) : !hasDailyAds ? (
              <p className="empty-state">Sin gasto en publicidad en este período.</p>
            ) : (
              <ResponsiveContainer width="100%" height="100%" minHeight={220}>
                <BarChart data={daily} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
                  <CartesianGrid stroke="var(--border-soft)" vertical={false} />
                  <XAxis dataKey="day" tickFormatter={shortDay} tick={{ fontSize: 12, fill: "var(--text-dim)" }} tickLine={false} axisLine={{ stroke: "var(--border)" }} minTickGap={28} />
                  <YAxis tick={{ fontSize: 12, fill: "var(--text-dim)" }} tickLine={false} axisLine={false} width={72} tickCount={4} tickFormatter={(v) => fmt(Number(v))} />
                  <Tooltip cursor={{ fill: "var(--surface-2)" }} content={<DailyAdsTooltip />} />
                  <Bar dataKey="ads" fill="var(--chart-ads)" radius={[3, 3, 0, 0]} isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>Campañas de Mercado Ads</h2>
            {campaigns && campaigns.length > 0 && (
              <span className="meta">{plural(campaigns.filter((c) => c.status === "active").length, "activa", "activas")}</span>
            )}
          </div>
          {campaignsError && <p className="field-error" role="alert" style={{ padding: "0 var(--space-5)" }}>{campaignsError}</p>}
          {campaigns === null ? (
            <p className="empty-state">Cargando campañas…</p>
          ) : campaigns.length === 0 ? (
            !campaignsError && <p className="empty-state">No tenés campañas de Product Ads. Cuando crees una en Mercado Libre aparece acá.</p>
          ) : (
            <div className="table-flush">
              <table>
                <thead>
                  <tr>
                    <th>Campaña</th>
                    <th className="num">Invertido</th>
                    <th className="num">ROAS</th>
                    <th aria-label="Acción" />
                  </tr>
                </thead>
                <tbody>
                  {campaigns.map((c) => {
                    const r = reportByCampaign.get(c.id);
                    return (
                      <tr key={c.id}>
                        <td>
                          <span className="title" style={{ fontWeight: 600 }}>{c.name}</span>
                          <span className="cell-sub">
                            {STATUS_LABEL[c.status] ?? c.status} · presupuesto {fmt(c.budget)}/día{r ? ` · ${plural(r.products, "publicación", "publicaciones")}` : ""}
                          </span>
                        </td>
                        <td className="num">{r ? fmt(r.spend) : "—"}</td>
                        <td className="num">{r ? times(r.roas) : "—"}</td>
                        <td style={{ textAlign: "right" }}>
                          <button className="btn btn-secondary btn-sm" onClick={() => toggleCampaign(c.id, c.status)} disabled={togglingId === c.id}>
                            {togglingId === c.id ? "…" : c.status === "active" ? "Pausar" : "Reactivar"}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      {adsReport && adsReport.products.length > 0 && (
        <details className="disclosure">
          <summary>Métricas de cada anuncio</summary>
          <div className="disclosure-body">
            <table>
              <thead>
                <tr>
                  <th>Publicación</th>
                  <th className="num">Invertido</th>
                  <th className="num">Vendido por Ads</th>
                  <th className="num">ROAS</th>
                  <th className="num">Clics</th>
                  <th className="num">CPC</th>
                  <th className="num">Conversión</th>
                  <th className="num">% de ventas por Ads</th>
                </tr>
              </thead>
              <tbody>
                {adsReport.products.map((p) => (
                  <tr key={p.productId}>
                    <td>
                      <span className="cell-title" title={p.title}>{p.title}</span>
                      <span className="cell-sub">{p.productId}</span>
                    </td>
                    <td className="num">{fmt(p.spend)}</td>
                    <td className="num">
                      {fmt(p.adRevenue)}
                      <span className="cell-sub">{p.adUnits.toLocaleString("es-AR")} u.</span>
                    </td>
                    <td className="num">{times(p.roas)}</td>
                    <td className="num">
                      {p.clicks.toLocaleString("es-AR")}
                      <span className="cell-sub">CTR {pct(p.ctr)}</span>
                    </td>
                    <td className="num">{p.cpc === null ? "—" : fmt(p.cpc)}</td>
                    <td className="num">{pct(p.cvr)}</td>
                    <td className="num">{pct(p.adShare)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      <section className="panel">
        <div className="panel-head">
          <h2>Publicidad en otras redes</h2>
          <span className="meta">Meta, Google o TikTok: se resta de la ganancia del día que la cargues</span>
        </div>
        <form className="ad-form ad-form-flat" onSubmit={submitAdSpend} noValidate>
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
      </section>
    </div>
  );
}
