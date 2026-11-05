"use client";

import { useEffect, useMemo, useState } from "react";
import { NoAccountState } from "../NoAccountState";
import type { PricingRates, PricingStatus } from "@/lib/pricing";
import { marginAt } from "@/lib/pricing";
import type { PriceToWin } from "@/mcp/tools";

interface PricingRow {
  id: string;
  title: string;
  sku: string | null;
  thumbnail: string | null;
  permalink: string | null;
  stock: number;
  price: number;
  cost: number | null;
  costSince: string | null;
  unitsSold: number;
  rates: PricingRates;
  variableRate: number;
  unitProfit: number | null;
  margin: number | null;
  floorPrice: number | null;
  suggestedPrice: number | null;
  status: PricingStatus;
}

interface PricingResponse {
  target: number;
  days: number;
  includeAds: boolean;
  counts: Partial<Record<PricingStatus, number>>;
  rows: PricingRow[];
}

type Filter = "todos" | "bajo_piso" | "bajo_objetivo" | "ok" | "sin_costo";

const STATUS_LABEL: Record<PricingStatus, string> = {
  bajo_piso: "Pierde plata",
  bajo_objetivo: "Bajo el objetivo",
  ok: "En objetivo",
  sin_costo: "Falta costo",
  sin_margen_posible: "Sin margen posible",
};
const STATUS_PILL: Record<PricingStatus, string> = {
  bajo_piso: "pill-neg",
  bajo_objetivo: "pill-neg",
  ok: "pill-pos",
  sin_costo: "pill-neutral",
  sin_margen_posible: "pill-neg",
};
const ORDER: Record<PricingStatus, number> = { bajo_piso: 0, sin_margen_posible: 1, bajo_objetivo: 2, ok: 3, sin_costo: 4 };

function fmt(n: number) {
  return n.toLocaleString("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 });
}
function pct(n: number | null) {
  return n === null ? "—" : `${(n * 100).toLocaleString("es-AR", { maximumFractionDigits: 1 })}%`;
}

function readPref<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}
function writePref(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* sin almacenamiento: se usa el valor por defecto la próxima vez */
  }
}

function RatesHint({ row, includeAds }: { row: PricingRow; includeAds: boolean }) {
  const r = row.rates;
  const parts = [
    `comisión ${pct(r.commission)}`,
    `IVA neto ${pct(r.iva)}`,
    r.tax > 0 ? `otros impuestos ${pct(r.tax)}` : null,
    includeAds && r.ads > 0 ? `publicidad ${pct(r.ads)}` : null,
    r.shippingPerUnit > 0 ? `envío ${fmt(r.shippingPerUnit)}/u.` : null,
  ].filter(Boolean);
  return (
    <span className="cell-sub" title={r.estimated ? "Vendió poco en el período: se usan las tasas promedio de tu cuenta" : "Tasas de las ventas de esta publicación"}>
      {parts.join(" · ")}
      {r.estimated ? " · estimado" : ""}
    </span>
  );
}

function Competition({ data }: { data: PriceToWin | "loading" | undefined }) {
  if (data === undefined) return <span className="cell-sub">—</span>;
  if (data === "loading") return <span className="cell-sub">Consultando…</span>;
  if (!data.available) return <span className="cell-sub" title={data.reason}>No disponible</span>;
  const winning = data.status === "winning" || data.status === "sharing_first_place";
  return (
    <span>
      <span className={`pill ${winning ? "pill-pos" : "pill-neg"}`}>{winning ? "Ganás" : "Perdés"}</span>
      {data.priceToWin != null && !winning && <span className="cell-sub">Para ganar: {fmt(data.priceToWin)}</span>}
      {data.winnerPrice != null && !winning && <span className="cell-sub">Gana a {fmt(data.winnerPrice)}</span>}
    </span>
  );
}

export default function PreciosPage() {
  const [target, setTarget] = useState(20);
  const [days, setDays] = useState(90);
  const [includeAds, setIncludeAds] = useState(true);
  const [data, setData] = useState<PricingResponse | null>(null);
  const [error, setError] = useState("");
  const [noAccount, setNoAccount] = useState(false);
  const [filter, setFilter] = useState<Filter>("todos");
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [applying, setApplying] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [competition, setCompetition] = useState<Record<string, PriceToWin | "loading">>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    setTarget(readPref("precios.target", 20));
    setDays(readPref("precios.days", 90));
    setIncludeAds(readPref("precios.ads", true));
  }, []);

  function load() {
    setError("");
    fetch(`/api/pricing?target=${target / 100}&days=${days}&ads=${includeAds ? 1 : 0}`)
      .then(async (r) => {
        if (r.status === 401) { setNoAccount(true); return; }
        if (!r.ok) throw new Error(String(r.status));
        setData(await r.json());
      })
      .catch(() => setError("No se pudieron calcular los precios. Probá recargar la página."));
  }
  useEffect(load, [target, days, includeAds]);

  const rows = useMemo(() => {
    const all = data?.rows ?? [];
    const q = query.trim().toLowerCase();
    return all
      .filter((r) => filter === "todos" || r.status === filter || (filter === "bajo_piso" && r.status === "sin_margen_posible"))
      .filter((r) => !q || r.title.toLowerCase().includes(q) || r.id.toLowerCase().includes(q) || (r.sku ?? "").toLowerCase().includes(q))
      .sort((a, b) => ORDER[a.status] - ORDER[b.status] || b.unitsSold - a.unitsSold);
  }, [data, filter, query]);

  if (noAccount) {
    return (
      <div>
        <h1>Precios</h1>
        <NoAccountState />
      </div>
    );
  }

  const counts = data?.counts ?? {};
  const losing = (counts.bajo_piso ?? 0) + (counts.sin_margen_posible ?? 0);

  function priceFor(r: PricingRow): number | null {
    const d = draft[r.id];
    if (d !== undefined && d.trim() !== "") {
      const n = Number(d.replace(/\./g, "").replace(",", "."));
      return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
    }
    // Si ya deja el objetivo, no se propone bajar el precio: el sugerido
    // queda solo como referencia de hasta dónde aguanta.
    if (r.status === "ok") return null;
    return r.suggestedPrice;
  }

  async function applyPrices(items: { row: PricingRow; price: number }[]) {
    if (items.length === 0) return;
    const lines = items.map(({ row, price }) => {
      const m = row.cost !== null ? marginAt(price, row.cost, row.rates, includeAds) : null;
      return `• ${row.title}: ${fmt(row.price)} → ${fmt(price)} (margen ${pct(m)})`;
    });
    const underFloor = items.filter(({ row, price }) => row.floorPrice !== null && price < row.floorPrice);
    const warning = underFloor.length > 0 ? `\n\n⚠ ${underFloor.length} precio(s) quedan por debajo del piso: esas ventas van a perder plata.` : "";
    if (!window.confirm(`Vas a cambiar ${items.length} precio(s) en Mercado Libre:\n\n${lines.slice(0, 15).join("\n")}${lines.length > 15 ? `\n… y ${lines.length - 15} más` : ""}${warning}\n\n¿Confirmás?`)) return;

    setNotice(null);
    let ok = 0;
    const failed: string[] = [];
    for (const { row, price } of items) {
      setApplying(row.id);
      try {
        const res = await fetch("/api/products/ml-update", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ productId: row.id, price }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          failed.push(`${row.title}: ${body.error ?? res.status}`);
        } else ok += 1;
      } catch (err) {
        failed.push(`${row.title}: ${(err as Error).message}`);
      }
    }
    setApplying(null);
    setSelected(new Set());
    setDraft({});
    setNotice(
      failed.length === 0
        ? { ok: true, text: `Listo: ${ok} precio(s) actualizado(s) en Mercado Libre.` }
        : { ok: false, text: `${ok} actualizado(s), ${failed.length} con error. ${failed.slice(0, 3).join(" · ")}` }
    );
    load();
  }

  async function loadCompetition(ids: string[]) {
    const pending = ids.filter((id) => competition[id] === undefined);
    setCompetition((c) => ({ ...c, ...Object.fromEntries(pending.map((id) => [id, "loading" as const])) }));
    for (let i = 0; i < pending.length; i += 4) {
      const chunk = pending.slice(i, i + 4);
      const results = await Promise.all(
        chunk.map((id) =>
          fetch(`/api/pricing/competition?productId=${id}`)
            .then((r) => r.json() as Promise<PriceToWin>)
            .catch((): PriceToWin => ({ available: false, reason: "No se pudo consultar." }))
        )
      );
      setCompetition((c) => ({ ...c, ...Object.fromEntries(chunk.map((id, j) => [id, results[j]])) }));
    }
  }

  const visibleIds = rows.slice(0, 60).map((r) => r.id);
  const selectedRows = rows.filter((r) => selected.has(r.id));

  return (
    <div className="precios-page">
      <div className="page-head">
        <h1>Precios</h1>
        <div className="page-head-actions">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => loadCompetition(visibleIds)}>
            Ver competencia
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={selectedRows.length === 0 || applying !== null}
            onClick={() => applyPrices(selectedRows.flatMap((row) => { const p = priceFor(row); return p ? [{ row, price: p }] : []; }))}
          >
            Aplicar {selectedRows.length > 0 ? `${selectedRows.length} ` : ""}precio(s)
          </button>
        </div>
      </div>

      <p className="page-finding">
        {data === null ? "Calculando…" : (
          <>
            {losing > 0 ? <><strong>{losing} publicación(es) venden por debajo de su piso</strong>: cada venta pierde plata. </> : "Ninguna publicación vende por debajo de su piso. "}
            {(counts.bajo_objetivo ?? 0) > 0 && <>{counts.bajo_objetivo} deja(n) menos que tu margen objetivo de {target}%. </>}
            {(counts.sin_costo ?? 0) > 0 && <>{counts.sin_costo} sin costo cargado: <a href="/productos">cargalo en Productos</a>.</>}
          </>
        )}
      </p>

      <div className="pricing-controls">
        <label>
          Margen objetivo
          <span className="input-suffix">
            <input type="number" min={0} max={60} step={1} value={target}
              onChange={(e) => { const v = Math.min(60, Math.max(0, Number(e.target.value) || 0)); setTarget(v); writePref("precios.target", v); }} />
            %
          </span>
        </label>
        <label>
          Tasas de los últimos
          <select value={days} onChange={(e) => { const v = Number(e.target.value); setDays(v); writePref("precios.days", v); }}>
            <option value={30}>30 días</option>
            <option value={90}>90 días</option>
            <option value={180}>180 días</option>
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={includeAds} onChange={(e) => { setIncludeAds(e.target.checked); writePref("precios.ads", e.target.checked); }} />
          Contar la publicidad
        </label>
        <input className="pricing-search" type="search" placeholder="Buscar por nombre, SKU o MLA…" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>

      <div className="pricing-tabs" role="tablist">
        {([
          ["todos", `Todos (${data?.rows.length ?? 0})`],
          ["bajo_piso", `Pierden plata (${losing})`],
          ["bajo_objetivo", `Bajo el objetivo (${counts.bajo_objetivo ?? 0})`],
          ["ok", `En objetivo (${counts.ok ?? 0})`],
          ["sin_costo", `Falta costo (${counts.sin_costo ?? 0})`],
        ] as [Filter, string][]).map(([f, label]) => (
          <button key={f} type="button" role="tab" aria-selected={filter === f} className={`period-btn${filter === f ? " active" : ""}`} onClick={() => setFilter(f)}>
            {label}
          </button>
        ))}
      </div>

      {error && <p className="field-error" role="alert">{error}</p>}
      {notice && <p role="status" className={notice.ok ? "success-text" : "missing-cost"}>{notice.text}</p>}

      <div className="table-wrap table-scroll">
        <table className="pricing-table">
          <thead>
            <tr>
              <th aria-label="Elegir" />
              <th>Publicación</th>
              <th className="num">Precio actual</th>
              <th className="num">Costo</th>
              <th className="num" title="Lo que deja cada unidad al precio actual, después de comisión, envío, impuestos y publicidad">Margen actual</th>
              <th className="num" title="Precio en el que la venta no deja ni pierde plata">Piso</th>
              <th className="num" title={`Precio que deja tu margen objetivo de ${target}%`}>Sugerido</th>
              <th>Competencia</th>
              <th>Nuevo precio</th>
            </tr>
          </thead>
          <tbody>
            {data === null ? (
              <tr><td colSpan={9} className="empty-state">Calculando precios…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={9} className="empty-state">No hay publicaciones en esta vista.</td></tr>
            ) : rows.slice(0, 200).map((r) => {
              const next = priceFor(r);
              const nextMargin = next !== null && r.cost !== null ? marginAt(next, r.cost, r.rates, includeAds) : null;
              const canApply = next !== null && next !== Math.round(r.price) && r.cost !== null;
              return (
                <tr key={r.id} className={selected.has(r.id) ? "row-selected" : undefined}>
                  <td>
                    <input type="checkbox" aria-label={`Elegir ${r.title}`} disabled={!canApply} checked={selected.has(r.id)}
                      onChange={(e) => setSelected((s) => { const n = new Set(s); if (e.target.checked) n.add(r.id); else n.delete(r.id); return n; })} />
                  </td>
                  <td>
                    <span className="pricing-title">
                      {r.thumbnail && <img src={r.thumbnail} alt="" width={32} height={32} loading="lazy" />}
                      <span>
                        <span className="cell-title" title={r.title}>{r.permalink ? <a href={r.permalink} target="_blank" rel="noreferrer">{r.title}</a> : r.title}</span>
                        <span className="cell-sub">
                          <span className={`pill ${STATUS_PILL[r.status]}`}>{STATUS_LABEL[r.status]}</span> {r.id}{r.sku ? ` · ${r.sku}` : ""} · {r.unitsSold} vendidas
                        </span>
                        {r.cost !== null && <RatesHint row={r} includeAds={includeAds} />}
                      </span>
                    </span>
                  </td>
                  <td className="num">{fmt(r.price)}</td>
                  <td className="num">
                    {r.cost === null ? <a href="/productos" className="missing-cost">Cargar</a> : fmt(r.cost)}
                    {r.costSince && <span className="cell-sub" title="Fecha del último costo cargado">desde {new Date(r.costSince).toLocaleDateString("es-AR")}</span>}
                  </td>
                  <td className={`num ${r.margin !== null && r.margin < 0 ? "num-neg" : ""}`}>
                    {pct(r.margin)}
                    {r.unitProfit !== null && <span className="cell-sub">{fmt(r.unitProfit)}/u.</span>}
                  </td>
                  <td className="num">{r.floorPrice === null ? "—" : fmt(r.floorPrice)}</td>
                  <td className="num">
                    {r.suggestedPrice === null ? "—" : r.status === "ok" ? (
                      <span title="Ya dejás tu margen objetivo: este es el precio más bajo que lo mantiene">
                        <span className="cell-sub">ya cumplís</span>{fmt(r.suggestedPrice)}
                      </span>
                    ) : <strong>{fmt(r.suggestedPrice)}</strong>}
                  </td>
                  <td>
                    <Competition data={competition[r.id]} />
                    {(() => {
                      const c = competition[r.id];
                      if (!c || c === "loading" || !c.available || c.priceToWin == null || r.suggestedPrice === null || r.status === "ok") return null;
                      if (r.floorPrice !== null && c.priceToWin < r.floorPrice) return <span className="cell-sub num-neg">Para ganar habría que vender bajo el piso</span>;
                      if (r.suggestedPrice > c.priceToWin) return <span className="cell-sub">El sugerido queda arriba del precio para ganar</span>;
                      return null;
                    })()}
                  </td>
                  <td>
                    <div className="pricing-apply">
                      <input
                        type="text"
                        inputMode="numeric"
                        aria-label={`Nuevo precio de ${r.title}`}
                        placeholder={r.status === "ok" ? "sin cambio" : r.suggestedPrice ? String(r.suggestedPrice) : "—"}
                        value={draft[r.id] ?? ""}
                        onChange={(e) => setDraft((d) => ({ ...d, [r.id]: e.target.value }))}
                      />
                      <button type="button" className="btn btn-secondary btn-sm" disabled={!canApply || applying !== null}
                        onClick={() => next !== null && applyPrices([{ row: r, price: next }])}>
                        {applying === r.id ? "…" : "Aplicar"}
                      </button>
                    </div>
                    {nextMargin !== null && canApply && (
                      <span className={`cell-sub ${r.floorPrice !== null && next! < r.floorPrice ? "num-neg" : ""}`}>
                        con {fmt(next!)}: margen {pct(nextMargin)}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="field-hint">
        Piso y sugerido salen de las ventas reales de cada publicación en los últimos {days} días: la comisión que cobró Mercado Libre (incluye
        el costo de las cuotas que ofrecés), el IVA, los otros impuestos de Configuración, la publicidad y el envío a tu cargo. Si una publicación
        vendió poco, se usan los promedios de tu cuenta y se marca como estimado. Ningún precio cambia en Mercado Libre sin que lo confirmes.
        La competencia solo existe para publicaciones de catálogo.
      </p>
    </div>
  );
}
