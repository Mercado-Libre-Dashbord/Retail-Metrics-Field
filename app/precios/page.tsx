"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NoAccountState } from "../NoAccountState";
import type { PricingRates } from "@/lib/pricing";
import type { Action, Recommendation } from "@/lib/recommend";
import type { PriceReference } from "@/mcp/tools";

interface Competitor { itemId: string; seller: string; price: number; previousPrice: number | null; changedAt: string | null; freeShipping: boolean | null; isWinner: boolean }
interface Item {
  id: string;
  title: string;
  sku: string | null;
  thumbnail: string | null;
  permalink: string | null;
  price: number;
  cost: number | null;
  unitsSold: number;
  floorPrice: number | null;
  suggestedPrice: number | null;
  margin: number | null;
  unitProfit: number | null;
  rates: PricingRates;
  recommendation: Recommendation;
  competition: {
    status: string; priceToWin: number | null; winnerPrice: number | null; position: number | null; competitorsCount: number;
    capturedAt: string; missing: string[]; have: string[]; competitors: Competitor[];
  } | null;
  reference: PriceReference | null;
}
interface Change { itemId: string; sellerNickname: string | null; from: number; to: number; changePct: number; at: string; productTitle: string | null; myPrice: number | null; nowCheaperThanMe: boolean | null }
interface Overview {
  target: number;
  days: number;
  competitionAvailable: boolean;
  lastUpdated: string | null;
  summary: { byAction: Partial<Record<Action, number>>; losingMonthly: number; raiseGain: number; catalogCount: number; notCatalogCount: number };
  items: Item[];
  changes: Change[];
}

type View = "hacer" | "pierden" | "catalogo" | "subir" | "revisar" | "bien" | "todas";

const VIEW_ACTIONS: Record<View, Action[] | null> = {
  hacer: ["subir_pierde", "bajar_para_ganar", "subir_sin_perder", "subir_al_objetivo", "no_bajes", "mejorar_condiciones", "revisar_costos", "cargar_costo", "mas_caro_que_mercado"],
  pierden: ["subir_pierde"],
  catalogo: ["bajar_para_ganar"],
  subir: ["subir_sin_perder", "subir_al_objetivo"],
  revisar: ["no_bajes", "mejorar_condiciones", "revisar_costos", "cargar_costo"],
  bien: ["ok", "mas_caro_que_mercado"],
  todas: null,
};

const TONE: Record<number, string> = { 1: "rec-urgent", 2: "rec-opportunity", 3: "rec-review", 4: "rec-optional", 5: "rec-ok" };
const AUTO_REFRESH_MS = 10 * 60 * 1000;

function fmt(n: number) {
  return n.toLocaleString("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 });
}
function pct(n: number | null) {
  return n === null ? "—" : `${(n * 100).toLocaleString("es-AR", { maximumFractionDigits: 1 })}%`;
}
function ago(iso: string | null) {
  if (!iso) return "nunca";
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (m < 1) return "recién";
  if (m < 60) return `hace ${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `hace ${h} h` : `hace ${Math.round(h / 24)} días`;
}
function readPref<T>(key: string, fallback: T): T {
  try { const v = localStorage.getItem(key); return v === null ? fallback : (JSON.parse(v) as T); } catch { return fallback; }
}
function writePref(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* sin almacenamiento */ }
}

function CatalogPill({ c }: { c: Item["competition"] }) {
  if (!c) return null;
  const winning = c.status === "winning" || c.status === "sharing_first_place";
  return (
    <span className={`pill ${winning ? "pill-pos" : "pill-neg"}`} title="Competencia en catálogo">
      Catálogo: {winning ? (c.status === "sharing_first_place" ? "compartís el 1.º" : "ganás") : "perdés"}
      {c.position ? ` · ${c.position}.º de ${c.competitorsCount + 1} por precio` : ""}
    </span>
  );
}

function Detail({ item, includeAds }: { item: Item; includeAds: boolean }) {
  const r = item.rates;
  const c = item.competition;
  const ref = item.reference;
  return (
    <div className="rec-detail">
      <div>
        <h4>Cómo se calcula</h4>
        <ul>
          <li>Costo del producto: <strong>{item.cost === null ? "sin cargar" : fmt(item.cost)}</strong></li>
          <li>Comisión de Mercado Libre: <strong>{pct(r.commission)}</strong> del precio (incluye las cuotas que ofrecés)</li>
          <li>IVA neto: <strong>{pct(r.iva)}</strong>{r.tax > 0 ? <> · otros impuestos: <strong>{pct(r.tax)}</strong></> : null}</li>
          {includeAds && r.ads > 0 && <li>Publicidad: <strong>{pct(r.ads)}</strong> del precio</li>}
          {r.shippingPerUnit > 0 && <li>Envío a tu cargo: <strong>{fmt(r.shippingPerUnit)}</strong> por unidad</li>}
          <li>Piso (no ganás ni perdés): <strong>{item.floorPrice === null ? "—" : fmt(item.floorPrice)}</strong> · para tu objetivo: <strong>{item.suggestedPrice === null ? "—" : fmt(item.suggestedPrice)}</strong></li>
          {r.estimated && <li className="field-hint">Vendió poco en el período: se usan los promedios de tu cuenta.</li>}
        </ul>
      </div>
      <div>
        <h4>Mercado</h4>
        {ref?.available ? (
          <ul>
            {ref.suggestedPrice != null && <li>Mercado Libre sugiere: <strong>{fmt(ref.suggestedPrice)}</strong></li>}
            {ref.lowestPrice != null && <li>Más barato entre similares: <strong>{fmt(ref.lowestPrice)}</strong></li>}
            {ref.percentDifference != null && <li>Diferencia con la referencia: <strong>{ref.percentDifference > 0 ? "+" : ""}{ref.percentDifference.toLocaleString("es-AR", { maximumFractionDigits: 1 })}%</strong></li>}
          </ul>
        ) : <p className="field-hint" style={{ margin: 0 }}>Mercado Libre no tiene referencia de precio para esta publicación.</p>}
        {c && (
          <>
            {c.missing.length > 0 && <p className="field-hint" style={{ margin: "6px 0 0" }}>Te falta para ganar: {c.missing.join(", ")}</p>}
            {c.have.length > 0 && <p className="field-hint" style={{ margin: "2px 0 0" }}>A favor: {c.have.join(", ")}</p>}
          </>
        )}
      </div>
      {c && c.competitors.length > 0 && (
        <div className="rec-detail-wide">
          <h4>Competidores del catálogo</h4>
          <table className="comp-sub">
            <thead><tr><th>Vendedor</th><th className="num">Precio</th><th className="num">vs. vos</th><th>Último cambio</th><th>Envío gratis</th></tr></thead>
            <tbody>
              {c.competitors.map((co) => (
                <tr key={co.itemId}>
                  <td>{co.seller}{co.isWinner && <span className="pill pill-info" style={{ marginLeft: 6 }}>gana</span>}</td>
                  <td className="num"><strong>{fmt(co.price)}</strong></td>
                  <td className={`num ${co.price < item.price ? "num-neg" : ""}`}>{co.price < item.price ? "−" : "+"}{fmt(Math.abs(co.price - item.price))}</td>
                  <td>{co.previousPrice !== null && co.changedAt ? `${fmt(co.previousPrice)} → ${fmt(co.price)}, ${ago(co.changedAt)}` : "—"}</td>
                  <td>{co.freeShipping === null ? "—" : co.freeShipping ? "Sí" : "No"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function PreciosPage() {
  const [target, setTarget] = useState(20);
  const [includeAds, setIncludeAds] = useState(true);
  const [data, setData] = useState<Overview | null>(null);
  const [noAccount, setNoAccount] = useState(false);
  const [error, setError] = useState("");
  const [view, setView] = useState<View>("hacer");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [applying, setApplying] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [refreshing, setRefreshing] = useState<string | null>(null);
  const busy = useRef(false);

  useEffect(() => {
    setTarget(readPref("precios.target", 20));
    setIncludeAds(readPref("precios.ads", true));
  }, []);

  const load = useCallback(async () => {
    const r = await fetch(`/api/prices/overview?target=${target / 100}&days=90&ads=${includeAds ? 1 : 0}`);
    if (r.status === 401) { setNoAccount(true); return; }
    if (!r.ok) { setError("No se pudieron calcular los precios. Probá recargar."); return; }
    setError("");
    setData(await r.json());
  }, [target, includeAds]);

  const refresh = useCallback(async (force = false, productIds?: string[]) => {
    if (busy.current) return;
    busy.current = true;
    try {
      let total = 0;
      for (let round = 0; round < 15; round++) {
        setRefreshing(total > 0 ? `Consultando a Mercado Libre… ${total} publicaciones` : "Consultando a Mercado Libre…");
        const res = await fetch("/api/competition/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ force, productIds }) });
        if (!res.ok) break;
        const { refreshed, remaining } = (await res.json()) as { refreshed: number; remaining: number };
        total += refreshed;
        if (refreshed > 0) await load();
        if (remaining === 0 || refreshed === 0) break;
      }
    } catch {
      /* se muestra lo guardado */
    } finally {
      busy.current = false;
      setRefreshing(null);
    }
  }, [load]);

  useEffect(() => {
    load().then(() => refresh(false));
    const t = setInterval(() => { if (document.visibilityState === "visible") refresh(false); }, AUTO_REFRESH_MS);
    return () => clearInterval(t);
  }, [load, refresh]);

  const items = useMemo(() => {
    const all = data?.items ?? [];
    const allowed = VIEW_ACTIONS[view];
    const q = query.trim().toLowerCase();
    return all
      .filter((i) => !allowed || allowed.includes(i.recommendation.action))
      .filter((i) => !q || i.title.toLowerCase().includes(q) || i.id.toLowerCase().includes(q) || (i.sku ?? "").toLowerCase().includes(q))
      .sort((a, b) =>
        a.recommendation.priority - b.recommendation.priority ||
        Math.abs((b.recommendation.monthlyAtTarget ?? 0) - (b.recommendation.monthlyNow ?? 0)) - Math.abs((a.recommendation.monthlyAtTarget ?? 0) - (a.recommendation.monthlyNow ?? 0)) ||
        b.unitsSold - a.unitsSold
      );
  }, [data, view, query]);

  if (noAccount) return (<div><h1>Precios</h1><NoAccountState /></div>);

  const s = data?.summary;
  const n = (a: Action[]) => a.reduce((t, x) => t + (s?.byAction[x] ?? 0), 0);

  async function apply(item: Item, price: number) {
    const m = item.cost !== null ? (price * (1 - item.rates.commission - item.rates.iva - item.rates.tax - (includeAds ? item.rates.ads : 0)) - item.cost - item.rates.shippingPerUnit) / price : null;
    const warn = item.floorPrice !== null && price < item.floorPrice ? "\n\n⚠ Queda por debajo del piso: cada venta pierde plata." : "";
    if (!window.confirm(`${item.title}\n\n${fmt(item.price)} → ${fmt(price)}${m !== null ? `  (te deja ${pct(m)})` : ""}${warn}\n\n¿Cambiar el precio en Mercado Libre?`)) return;
    setApplying(item.id);
    setNotice(null);
    try {
      const res = await fetch("/api/products/ml-update", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ productId: item.id, price }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) setNotice({ ok: false, text: `${item.title}: ${body.error ?? "Mercado Libre rechazó el cambio."}` });
      else {
        setNotice({ ok: true, text: `Listo: ${item.title} quedó a ${fmt(price)} en Mercado Libre.` });
        setCustom((c) => ({ ...c, [item.id]: "" }));
        await load();
        refresh(true, [item.id]);
      }
    } finally {
      setApplying(null);
    }
  }

  const tabs: [View, string][] = [
    ["hacer", `Para hacer (${n(VIEW_ACTIONS.hacer!)})`],
    ["pierden", `Pierden plata (${n(["subir_pierde"])})`],
    ["catalogo", `Ganar el catálogo (${n(["bajar_para_ganar"])})`],
    ["subir", `Podés subir (${n(["subir_sin_perder", "subir_al_objetivo"])})`],
    ["revisar", `Para revisar (${n(VIEW_ACTIONS.revisar!)})`],
    ["bien", `Están bien (${n(VIEW_ACTIONS.bien!)})`],
    ["todas", `Todas (${data?.items.length ?? 0})`],
  ];

  return (
    <div className="precios-page">
      <div className="page-head">
        <h1>Precios y competencia</h1>
        <div className="page-head-actions">
          <label className="inline-field" title="El margen que querés que te deje cada venta, después de todo">
            Margen objetivo
            <input type="number" min={0} max={60} value={target}
              onChange={(e) => { const v = Math.min(60, Math.max(0, Number(e.target.value) || 0)); setTarget(v); writePref("precios.target", v); }} />%
          </label>
          <label className="inline-field">
            <input type="checkbox" checked={includeAds} onChange={(e) => { setIncludeAds(e.target.checked); writePref("precios.ads", e.target.checked); }} />
            contar publicidad
          </label>
          <span className="field-hint" style={{ margin: 0 }}>{refreshing ?? `Competencia ${ago(data?.lastUpdated ?? null)}`}</span>
          <button type="button" className="btn btn-secondary btn-sm" disabled={refreshing !== null} onClick={() => refresh(true)}>Actualizar</button>
        </div>
      </div>

      {error && <p className="field-error" role="alert">{error}</p>}
      {notice && <p role="status" className={notice.ok ? "success-text" : "missing-cost"}>{notice.text}</p>}
      {data && !data.competitionAvailable && (
        <p className="missing-cost">Falta correr <code>db/postgres/migrations/027-competencia.sql</code> en Supabase para ver la competencia.</p>
      )}

      <div className="rec-summary">
        <button type="button" className={`rec-sum urgent${view === "pierden" ? " active" : ""}`} onClick={() => setView("pierden")}>
          <span className="label">Pierden plata</span>
          <strong>{n(["subir_pierde"])}</strong>
          <span className="sub">{s && s.losingMonthly > 0 ? `≈ −${fmt(s.losingMonthly)} por mes` : "ninguna"}</span>
        </button>
        <button type="button" className={`rec-sum opportunity${view === "catalogo" ? " active" : ""}`} onClick={() => setView("catalogo")}>
          <span className="label">Ganás el catálogo bajando</span>
          <strong>{n(["bajar_para_ganar"])}</strong>
          <span className="sub">sin bajar del piso</span>
        </button>
        <button type="button" className={`rec-sum opportunity${view === "subir" ? " active" : ""}`} onClick={() => setView("subir")}>
          <span className="label">Podés subir</span>
          <strong>{n(["subir_sin_perder", "subir_al_objetivo"])}</strong>
          <span className="sub">{s && s.raiseGain > 0 ? `≈ +${fmt(s.raiseGain)} por mes si vendés lo mismo` : "—"}</span>
        </button>
        <button type="button" className={`rec-sum review${view === "revisar" ? " active" : ""}`} onClick={() => setView("revisar")}>
          <span className="label">Bajar no alcanza o no conviene</span>
          <strong>{n(["no_bajes", "mejorar_condiciones", "revisar_costos"])}</strong>
          <span className="sub">envío, Full, reputación o costos</span>
        </button>
      </div>

      <div className="rec-layout">
        <section>
          <div className="rec-toolbar">
            <div className="pricing-tabs" role="tablist">
              {tabs.map(([v, label]) => (
                <button key={v} type="button" role="tab" aria-selected={view === v} className={`period-btn${view === v ? " active" : ""}`} onClick={() => setView(v)}>{label}</button>
              ))}
            </div>
            <input className="pricing-search" type="search" placeholder="Buscar…" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>

          {data === null ? <p className="empty-state">Calculando…</p> : items.length === 0 ? (
            <p className="empty-state">{view === "hacer" ? "No hay nada urgente: todos tus precios están bien." : "No hay publicaciones en esta vista."}</p>
          ) : (
            <ul className="rec-list">
              {items.slice(0, 150).map((item) => {
                const rec = item.recommendation;
                const isOpen = open === item.id;
                const customPrice = Number((custom[item.id] ?? "").replace(/\./g, "").replace(",", "."));
                const otherPrice = Number.isFinite(customPrice) && customPrice > 0 ? Math.round(customPrice) : null;
                return (
                  <li key={item.id} className={`rec-card ${TONE[rec.priority]}`}>
                    <div className="rec-main">
                      {item.thumbnail ? <img src={item.thumbnail} alt="" width={44} height={44} loading="lazy" /> : <span className="rec-thumb" />}
                      <div className="rec-body">
                        <div className="rec-title">
                          {item.permalink ? <a href={item.permalink} target="_blank" rel="noreferrer">{item.title}</a> : item.title}
                          <span className="cell-sub">{item.id}{item.sku ? ` · ${item.sku}` : ""} · {item.unitsSold} vendidas en {data.days} días</span>
                        </div>
                        <p className="rec-headline">{rec.headline}</p>
                        <p className="rec-why">{rec.detail}</p>
                        <div className="rec-numbers">
                          <span>Hoy <strong>{fmt(item.price)}</strong>{rec.profitNow !== null && <> · te deja <strong className={rec.profitNow < 0 ? "num-neg" : ""}>{fmt(rec.profitNow)}</strong> ({pct(item.margin)})</>}{rec.monthlyNow !== null && <> · ≈ {fmt(rec.monthlyNow)}/mes</>}</span>
                          {rec.targetPrice !== null && (
                            <span>→ A <strong>{fmt(rec.targetPrice)}</strong>{rec.profitAtTarget !== null && <> · te deja <strong>{fmt(rec.profitAtTarget)}</strong> ({pct(rec.marginAtTarget)})</>}{rec.monthlyAtTarget !== null && <> · ≈ {fmt(rec.monthlyAtTarget)}/mes</>}</span>
                          )}
                          <CatalogPill c={item.competition} />
                        </div>
                      </div>
                      <div className="rec-actions">
                        {rec.targetPrice !== null && rec.buttonLabel && (
                          <button type="button" className={`btn btn-sm ${rec.priority <= 2 && !rec.weak ? "btn-primary" : "btn-secondary"}`} disabled={applying !== null} onClick={() => apply(item, rec.targetPrice!)}>
                            {applying === item.id ? "…" : rec.buttonLabel}
                          </button>
                        )}
                        {item.cost === null && <a className="btn btn-secondary btn-sm" href="/productos">Cargar costo</a>}
                        {item.cost !== null && (
                          <div className="rec-other">
                            <input type="text" inputMode="numeric" placeholder="Otro precio" aria-label={`Otro precio para ${item.title}`} value={custom[item.id] ?? ""}
                              onChange={(e) => setCustom((c) => ({ ...c, [item.id]: e.target.value }))} />
                            <button type="button" className="btn btn-secondary btn-sm" disabled={otherPrice === null || applying !== null} onClick={() => otherPrice && apply(item, otherPrice)}>Aplicar</button>
                          </div>
                        )}
                        <button type="button" className="link-btn" onClick={() => setOpen(isOpen ? null : item.id)}>{isOpen ? "Ocultar detalle" : "Ver detalle"}</button>
                      </div>
                    </div>
                    {isOpen && <Detail item={item} includeAds={includeAds} />}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <aside className="chart-card comp-feed" aria-labelledby="feed-title">
          <div className="chart-card-head"><h3 className="chart-card-title" id="feed-title">Qué cambió la competencia</h3><span className="field-hint" style={{ margin: 0 }}>7 días</span></div>
          {data === null ? <p className="field-hint">Cargando…</p> : data.changes.length === 0 ? (
            <p className="field-hint">
              {data.summary.catalogCount === 0
                ? "Mercado Libre muestra competidores solo en publicaciones de catálogo, y todavía no hay ninguna tuya con datos."
                : "Sin cambios de precio de la competencia todavía. Cuando un competidor cambie su precio, aparece acá."}
            </p>
          ) : (
            <ul className="comp-changes">
              {data.changes.slice(0, 30).map((ch, i) => (
                <li key={`${ch.itemId}-${ch.at}-${i}`}>
                  <span className={`comp-arrow ${ch.to < ch.from ? "down" : "up"}`} aria-hidden="true">{ch.to < ch.from ? "↓" : "↑"}</span>
                  <div>
                    <div><strong>{ch.sellerNickname ?? ch.itemId}</strong> {ch.to < ch.from ? "bajó" : "subió"} {ch.productTitle ?? ""}</div>
                    <div className="cell-sub">
                      {fmt(ch.from)} → <strong>{fmt(ch.to)}</strong> ({ch.changePct > 0 ? "+" : ""}{pct(ch.changePct)}) · {ago(ch.at)}
                      {ch.nowCheaperThanMe ? <span className="num-neg"> · ahora más barato que vos</span> : null}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>

      <p className="field-hint">
        Cada recomendación sale de tus ventas reales de los últimos {data?.days ?? 90} días (comisión de Mercado Libre con las cuotas incluidas, IVA, otros
        impuestos, publicidad y envío a tu cargo), de la competencia en catálogo y de la referencia de precios de Mercado Libre. Nunca se recomienda un
        precio por debajo del piso. Lo &quot;por mes&quot; es un estimado si vendés lo mismo. Nada cambia en Mercado Libre sin que lo confirmes; si una
        publicación tiene activa la automatización de precios de Mercado Libre, se avisa en vez de cambiarla.
        {data && data.summary.notCatalogCount > 0 ? ` ${data.summary.notCatalogCount} publicaciones no son de catálogo: para esas se usa la referencia de precios de Mercado Libre.` : ""}
      </p>
    </div>
  );
}
