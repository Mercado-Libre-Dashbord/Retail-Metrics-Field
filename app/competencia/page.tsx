"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { NoAccountState } from "../NoAccountState";
import type { CompetitionReading } from "@/lib/competition";

interface Competitor {
  itemId: string;
  seller: string;
  price: number;
  previousPrice: number | null;
  changedAt: string | null;
  freeShipping: boolean | null;
  isWinner: boolean;
}

interface Row {
  id: string;
  title: string;
  thumbnail: string | null;
  permalink: string | null;
  capturedAt: string;
  status: string;
  myPrice: number | null;
  priceToWin: number | null;
  winnerPrice: number | null;
  visitShare: string | null;
  cost: number | null;
  floorPrice: number | null;
  suggestedPrice: number | null;
  unitsSold: number;
  reading: CompetitionReading;
  competitors: Competitor[];
  position: number | null;
  competitorsCount: number;
}

interface Change {
  itemId: string;
  sellerNickname: string | null;
  from: number;
  to: number;
  changePct: number;
  at: string;
  productId: string | null;
  productTitle: string | null;
  myPrice: number | null;
  nowCheaperThanMe: boolean | null;
}

interface Data {
  available: boolean;
  lastUpdated: string | null;
  counts: { total: number; ganando: number; perdiendoPorPrecio: number; perdiendoPorOtraCosa: number; notCatalog: number; cambios: number };
  rows: Row[];
  changes: Change[];
}

type Filter = "todos" | "precio" | "no_precio" | "ganas";

const AUTO_REFRESH_MS = 10 * 60 * 1000;

function fmt(n: number) {
  return n.toLocaleString("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 });
}
function pct(n: number | null, digits = 1) {
  return n === null ? "—" : `${(n * 100).toLocaleString("es-AR", { maximumFractionDigits: digits })}%`;
}
function ago(iso: string | null) {
  if (!iso) return "nunca";
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (m < 1) return "recién";
  if (m < 60) return `hace ${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `hace ${h} h`;
  return `hace ${Math.round(h / 24)} días`;
}

const VERDICT: Record<CompetitionReading["verdict"], { label: string; cls: string }> = {
  igualar_conviene: { label: "Conviene igualar", cls: "pill-pos" },
  igualar_bajo_objetivo: { label: "Igualar deja poco", cls: "pill-info" },
  igualar_pierde: { label: "Igualar pierde plata", cls: "pill-neg" },
  no_hace_falta: { label: "No es por precio", cls: "pill-neutral" },
  sin_costo: { label: "Falta costo", cls: "pill-neutral" },
  sin_dato: { label: "Sin dato", cls: "pill-neutral" },
};

function Status({ row }: { row: Row }) {
  const r = row.reading;
  if (r.cause === "ganas") return <span className="pill pill-pos">Ganás</span>;
  if (r.cause === "precio") return <span className="pill pill-neg">Perdés por precio</span>;
  if (r.cause === "no_precio") return <span className="pill pill-neg">Perdés (no por precio)</span>;
  return <span className="pill pill-neutral">Sin dato</span>;
}

export default function CompetenciaPage() {
  const [data, setData] = useState<Data | null>(null);
  const [noAccount, setNoAccount] = useState(false);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("todos");
  const [open, setOpen] = useState<string | null>(null);
  const [applying, setApplying] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [target, setTarget] = useState(20);
  const busy = useRef(false);

  useEffect(() => {
    try {
      const t = localStorage.getItem("precios.target");
      if (t !== null) setTarget(Number(JSON.parse(t)) || 20);
    } catch { /* sin almacenamiento */ }
  }, []);

  const load = useCallback(async () => {
    const r = await fetch(`/api/competition?target=${target / 100}&days=7`);
    if (r.status === 401) { setNoAccount(true); return; }
    if (!r.ok) { setError("No se pudo leer la competencia. Probá recargar."); return; }
    setData(await r.json());
  }, [target]);

  const refresh = useCallback(async (force = false, productIds?: string[]) => {
    if (busy.current) return;
    busy.current = true;
    setError("");
    try {
      let total = 0;
      for (let round = 0; round < 15; round++) {
        setRefreshing(total > 0 ? `Consultando a Mercado Libre… ${total} publicaciones` : "Consultando a Mercado Libre…");
        const res = await fetch("/api/competition/refresh", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ force, productIds }),
        });
        if (!res.ok) throw new Error(String(res.status));
        const { refreshed, remaining } = (await res.json()) as { refreshed: number; remaining: number };
        total += refreshed;
        await load();
        if (remaining === 0 || refreshed === 0) break;
      }
    } catch {
      setError("Mercado Libre no respondió. Probá de nuevo en un minuto.");
    } finally {
      busy.current = false;
      setRefreshing(null);
    }
  }, [load]);

  // Al entrar: lo guardado al instante y después lo que esté viejo. Mientras
  // la pantalla esté abierta, cada 10 minutos (además de los avisos de ML).
  useEffect(() => {
    load().then(() => refresh(false));
    const t = setInterval(() => { if (document.visibilityState === "visible") refresh(false); }, AUTO_REFRESH_MS);
    return () => clearInterval(t);
  }, [load, refresh]);

  if (noAccount) return (<div><h1>Competencia</h1><NoAccountState /></div>);

  async function applyPrice(row: Row, price: number) {
    const margin = row.cost !== null && row.reading.marginAtWin !== null && price === row.priceToWin ? row.reading.marginAtWin : null;
    const warn = row.floorPrice !== null && price < row.floorPrice ? "\n\n⚠ Queda por debajo del piso: cada venta pierde plata." : "";
    if (!window.confirm(`${row.title}\n\n${fmt(row.myPrice ?? 0)} → ${fmt(price)}${margin !== null ? ` (margen ${pct(margin)})` : ""}${warn}\n\n¿Cambiar el precio en Mercado Libre?`)) return;
    setApplying(row.id);
    setNotice(null);
    try {
      const res = await fetch("/api/products/ml-update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId: row.id, price }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) setNotice({ ok: false, text: body.error ?? "Mercado Libre rechazó el cambio." });
      else {
        setNotice({ ok: true, text: `Listo: ${row.title} ahora está a ${fmt(price)}.` });
        await refresh(true, [row.id]);
      }
    } finally {
      setApplying(null);
    }
  }

  if (data && !data.available) {
    return (
      <div>
        <h1>Competencia</h1>
        <div className="empty-state">
          <p style={{ margin: 0, fontWeight: 600, color: "var(--text)" }}>Falta un paso en la base de datos.</p>
          <p style={{ margin: "var(--space-2) 0 0" }}>Corré <code>db/postgres/migrations/027-competencia.sql</code> en el SQL Editor de Supabase y recargá.</p>
        </div>
      </div>
    );
  }

  const c = data?.counts;
  const rows = (data?.rows ?? [])
    .filter((r) => filter === "todos" || (filter === "ganas" ? r.reading.cause === "ganas" : r.reading.cause === filter))
    .sort((a, b) => {
      const order = { precio: 0, no_precio: 1, sin_dato: 2, ganas: 3 } as const;
      return order[a.reading.cause] - order[b.reading.cause] || (b.reading.overBy ?? 0) - (a.reading.overBy ?? 0) || b.unitsSold - a.unitsSold;
    });

  return (
    <div className="competencia-page">
      <div className="page-head">
        <h1>Competencia</h1>
        <div className="page-head-actions">
          <span className="field-hint" style={{ margin: 0 }}>
            {refreshing ?? `Actualizado ${ago(data?.lastUpdated ?? null)} · se actualiza solo cada 10 min`}
          </span>
          <button type="button" className="btn btn-primary btn-sm" disabled={refreshing !== null} onClick={() => refresh(true)}>
            Actualizar ahora
          </button>
        </div>
      </div>

      {error && <p className="field-error" role="alert">{error}</p>}
      {notice && <p role="status" className={notice.ok ? "success-text" : "missing-cost"}>{notice.text}</p>}

      <div className="kpi-grid kpi-compact comp-kpis">
        <div className="kpi-card"><span className="label">Ganás el catálogo</span><div className="value">{c ? `${c.ganando} de ${c.total}` : "—"}</div></div>
        <div className="kpi-card"><span className="label">Perdés por precio</span><div className="value" style={{ color: c?.perdiendoPorPrecio ? "var(--negative)" : undefined }}>{c?.perdiendoPorPrecio ?? "—"}</div></div>
        <div className="kpi-card"><span className="label">Perdés por otra cosa</span><div className="value">{c?.perdiendoPorOtraCosa ?? "—"}</div><span className="field-hint" style={{ margin: 0 }}>envío, Full, cuotas, reputación</span></div>
        <div className="kpi-card"><span className="label">Cambios de precio de la competencia</span><div className="value">{c?.cambios ?? "—"}</div><span className="field-hint" style={{ margin: 0 }}>últimos 7 días</span></div>
      </div>

      <div className="comp-grid">
        <section className="chart-card comp-feed" aria-labelledby="feed-title">
          <div className="chart-card-head"><h3 className="chart-card-title" id="feed-title">Qué cambió la competencia</h3></div>
          {data === null ? <p className="empty-state">Cargando…</p> : data.changes.length === 0 ? (
            <p className="field-hint">Todavía no hay cambios registrados. Cada vez que un competidor cambie su precio, aparece acá.</p>
          ) : (
            <ul className="comp-changes">
              {data.changes.slice(0, 40).map((ch, i) => (
                <li key={`${ch.itemId}-${ch.at}-${i}`}>
                  <span className={`comp-arrow ${ch.to < ch.from ? "down" : "up"}`} aria-hidden="true">{ch.to < ch.from ? "↓" : "↑"}</span>
                  <div>
                    <div><strong>{ch.sellerNickname ?? ch.itemId}</strong> {ch.to < ch.from ? "bajó" : "subió"} {ch.productTitle ?? ""}</div>
                    <div className="cell-sub">
                      {fmt(ch.from)} → <strong>{fmt(ch.to)}</strong> ({ch.changePct > 0 ? "+" : ""}{pct(ch.changePct)}) · {ago(ch.at)}
                      {ch.nowCheaperThanMe ? <span className="num-neg"> · ahora más barato que vos ({fmt(ch.myPrice!)})</span> : null}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="comp-table-wrap">
          <div className="pricing-tabs" role="tablist">
            {([["todos", `Todas (${c?.total ?? 0})`], ["precio", `Perdés por precio (${c?.perdiendoPorPrecio ?? 0})`], ["no_precio", `Perdés por otra cosa (${c?.perdiendoPorOtraCosa ?? 0})`], ["ganas", `Ganás (${c?.ganando ?? 0})`]] as [Filter, string][]).map(([f, label]) => (
              <button key={f} type="button" role="tab" aria-selected={filter === f} className={`period-btn${filter === f ? " active" : ""}`} onClick={() => setFilter(f)}>{label}</button>
            ))}
          </div>
          <div className="table-wrap table-scroll">
            <table className="pricing-table">
              <thead>
                <tr>
                  <th>Publicación</th>
                  <th className="num">Tu precio</th>
                  <th className="num">Gana a</th>
                  <th className="num" title="El precio con el que pasarías a ganar, según Mercado Libre">Para ganar</th>
                  <th>Por qué</th>
                  <th title="Lo que te deja cada venta si bajás al precio para ganar">Si igualás</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data === null ? (
                  <tr><td colSpan={7} className="empty-state">Cargando…</td></tr>
                ) : rows.length === 0 ? (
                  <tr><td colSpan={7} className="empty-state">
                    {data.counts.total === 0
                      ? data.counts.notCatalog > 0
                        ? `Ninguna de tus ${data.counts.notCatalog} publicaciones consultadas es de catálogo: Mercado Libre solo compara precios en catálogo.`
                        : "Todavía no hay datos: tocá Actualizar ahora."
                      : "No hay publicaciones en esta vista."}
                  </td></tr>
                ) : rows.map((r) => {
                  const rd = r.reading;
                  const isOpen = open === r.id;
                  return (
                    <Fragment key={r.id}>
                      <tr onClick={() => setOpen(isOpen ? null : r.id)} style={{ cursor: "pointer" }}>
                        <td>
                          <span className="pricing-title">
                            {r.thumbnail && <img src={r.thumbnail} alt="" width={32} height={32} loading="lazy" />}
                            <span>
                              <span className="cell-title" title={r.title}>{isOpen ? "▾ " : "▸ "}{r.title}</span>
                              <span className="cell-sub"><Status row={r} /> {r.position ? ` · puesto ${r.position} de ${r.competitorsCount + 1} por precio` : ""} · {ago(r.capturedAt)}</span>
                            </span>
                          </span>
                        </td>
                        <td className="num">{r.myPrice === null ? "—" : fmt(r.myPrice)}</td>
                        <td className="num">
                          {rd.cause === "ganas" ? <span className="cell-sub">vos</span> : r.winnerPrice === null ? "—" : fmt(r.winnerPrice)}
                          {rd.cause !== "ganas" && r.winnerPrice !== null && r.myPrice !== null && (
                            <span className={`cell-sub ${r.winnerPrice < r.myPrice ? "num-neg" : ""}`}>
                              {r.winnerPrice < r.myPrice ? `${fmt(r.myPrice - r.winnerPrice)} más barato` : r.winnerPrice > r.myPrice ? `${fmt(r.winnerPrice - r.myPrice)} más caro` : "mismo precio"}
                            </span>
                          )}
                        </td>
                        <td className="num">
                          {rd.cause === "ganas" ? "—" : r.priceToWin === null ? "—" : <strong>{fmt(r.priceToWin)}</strong>}
                          {rd.overBy !== null && <span className="cell-sub">bajar {fmt(rd.overBy)} ({pct(rd.overByPct)})</span>}
                        </td>
                        <td>
                          {rd.cause === "precio" && <span className="cell-sub">Estás {pct(rd.overByPct)} más caro{rd.missing.length ? `; además te falta ${rd.missing.join(", ")}` : ""}</span>}
                          {rd.cause === "no_precio" && <span className="cell-sub">No es el precio: {rd.missing.length ? `te falta ${rd.missing.join(", ")}` : "Mercado Libre no detalla el motivo"}</span>}
                          {rd.cause === "ganas" && <span className="cell-sub">{rd.have.length ? `A favor: ${rd.have.join(", ")}` : "Tenés el mejor precio y condiciones"}</span>}
                        </td>
                        <td>
                          {rd.cause === "precio" ? (
                            <>
                              <span className={`pill ${VERDICT[rd.verdict].cls}`}>{VERDICT[rd.verdict].label}</span>
                              {rd.marginAtWin !== null && <span className="cell-sub">margen {pct(rd.marginAtWin)} · {fmt(rd.profitAtWin ?? 0)}/u.</span>}
                              {rd.verdict === "igualar_pierde" && r.floorPrice !== null && <span className="cell-sub">tu piso es {fmt(r.floorPrice)}</span>}
                            </>
                          ) : <span className="cell-sub">—</span>}
                        </td>
                        <td onClick={(e) => e.stopPropagation()}>
                          {rd.cause === "precio" && r.priceToWin !== null && rd.verdict !== "sin_costo" && (
                            <button type="button" className={`btn btn-sm ${rd.verdict === "igualar_conviene" ? "btn-primary" : "btn-secondary"}`} disabled={applying !== null}
                              onClick={() => applyPrice(r, Math.round(r.priceToWin!))}>
                              {applying === r.id ? "…" : `Igualar a ${fmt(r.priceToWin)}`}
                            </button>
                          )}
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="comp-detail">
                          <td colSpan={7}>
                            {r.competitors.length === 0 ? (
                              <p className="field-hint" style={{ margin: 0 }}>Mercado Libre no devolvió la lista de competidores de este catálogo.</p>
                            ) : (
                              <table className="comp-sub">
                                <thead><tr><th>Vendedor</th><th className="num">Precio</th><th className="num">Antes</th><th>Cambió</th><th>Envío gratis</th><th /></tr></thead>
                                <tbody>
                                  {r.competitors.map((co) => (
                                    <tr key={co.itemId}>
                                      <td>{co.seller}</td>
                                      <td className="num"><strong>{fmt(co.price)}</strong>{r.myPrice !== null && <span className={`cell-sub ${co.price < r.myPrice ? "num-neg" : ""}`}>{co.price < r.myPrice ? `${pct((r.myPrice - co.price) / r.myPrice)} más barato que vos` : co.price > r.myPrice ? `${pct((co.price - r.myPrice) / r.myPrice)} más caro` : "igual"}</span>}</td>
                                      <td className="num">{co.previousPrice === null ? "—" : fmt(co.previousPrice)}</td>
                                      <td>{co.changedAt ? ago(co.changedAt) : "—"}</td>
                                      <td>{co.freeShipping === null ? "—" : co.freeShipping ? "Sí" : "No"}</td>
                                      <td>{co.isWinner && <span className="pill pill-info">Gana el catálogo</span>}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <p className="field-hint">
        Mercado Libre solo compara precios en publicaciones de catálogo (las que compiten por el mismo producto): de esas sale quién gana, a qué precio
        y por qué. El margen &quot;si igualás&quot; usa tu costo y la comisión, el envío, los impuestos y la publicidad reales de tus ventas, igual que en Precios.
        Nada cambia en Mercado Libre sin que lo confirmes.
        {c && c.notCatalog > 0 ? ` ${c.notCatalog} publicación(es) no son de catálogo y no se muestran.` : ""}
      </p>
    </div>
  );
}
