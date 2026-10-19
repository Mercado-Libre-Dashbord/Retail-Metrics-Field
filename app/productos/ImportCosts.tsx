"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  buildPreview, detectColumns, extractRows, parseCsv, selectedByDefault,
  type Cell, type MatchItem, type ProductRef,
} from "@/lib/cost-import";

const CHUNK = 25;

const fmt = (n: number) => n.toLocaleString("es-AR", { style: "currency", currency: "ARS", minimumFractionDigits: 2 });
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Argentina/Buenos_Aires" });

/** Excel guarda los CSV en Windows-1252 si no se elige UTF-8: si el texto trae caracteres rotos se vuelve a leer así. */
async function readCsv(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const utf8 = new TextDecoder("utf-8").decode(buffer);
  return utf8.includes("�") ? new TextDecoder("windows-1252").decode(buffer) : utf8;
}

const isExcel = (file: File) => /\.xlsx$/i.test(file.name);

interface Cols {
  codeCol: number;
  costCol: number;
  eanCol: number;
  nameCol: number;
}

export function ImportCosts({ products, onDone }: { products: ProductRef[]; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [rows, setRows] = useState<Cell[][] | null>(null);
  const [sheets, setSheets] = useState<string[]>([]);
  const [sheet, setSheet] = useState("");
  const [headerRow, setHeaderRow] = useState(0);
  const [cols, setCols] = useState<Cols>({ codeCol: -1, costCol: -1, eanCol: -1, nameCol: -1 });
  const [validFrom, setValidFrom] = useState(today());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<{ updated: number; unchanged: number; itemsUpdated: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Sin la migración 023 la API no manda los EAN ni los SKU de variantes.
  const hasCodes = products.some((p) => p.gtins !== undefined);
  const headers = rows?.[headerRow] ?? [];
  const extracted = useMemo(
    () => (rows && cols.costCol >= 0 && (cols.codeCol >= 0 || cols.eanCol >= 0) ? extractRows(rows, headerRow, cols) : null),
    [rows, headerRow, cols]
  );
  const preview = useMemo(() => (extracted ? buildPreview(extracted.rows, products) : null), [extracted, products]);
  // Qué cruces se aplican y con cuántas unidades por publicación. Arranca con
  // lo seguro marcado (nombres que coinciden, sin conflicto) y la cantidad que
  // sugiere el título; todo se puede cambiar antes de guardar.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [units, setUnits] = useState<Record<string, number>>({});
  const [filter, setFilter] = useState<"review" | "all">("review");
  useEffect(() => {
    if (!preview) return;
    setSelected(new Set(preview.items.filter(selectedByDefault).map((it) => it.key)));
    setUnits(Object.fromEntries(preview.items.map((it) => [it.key, it.packUnits])));
  }, [preview]);
  const unitsOf = (it: MatchItem) => units[it.key] ?? it.packUnits;
  const newCost = (it: MatchItem) => it.row.cost * unitsOf(it);
  const changes = (it: MatchItem) => it.product.currentCost === null || Math.abs(it.product.currentCost - newCost(it)) >= 0.005;
  const items = preview?.items ?? [];
  const review = items.filter((it) => !selectedByDefault(it) || it.packUnits > 1);
  const shown = filter === "review" ? review : items;
  const toSave = items.filter((it) => selected.has(it.key) && changes(it));
  // Una publicación recibe un solo costo aunque se marquen dos artículos.
  const dupSelected = new Set<string>();
  {
    const seen = new Set<string>();
    for (const it of items) if (selected.has(it.key)) { if (seen.has(it.product.id)) dupSelected.add(it.product.id); seen.add(it.product.id); }
  }
  const toggle = (key: string) => setSelected((prev) => { const n = new Set(prev); if (n.has(key)) n.delete(key); else n.add(key); return n; });

  function loadRows(parsed: Cell[][], date: string | null) {
    const detected = detectColumns(parsed);
    setRows(parsed);
    setValidFrom(date && date <= today() ? date : today());
    if (detected) {
      setHeaderRow(detected.headerRow);
      setCols({ codeCol: detected.codeCol, costCol: detected.costCol, eanCol: detected.eanCol, nameCol: detected.nameCol });
      setError("");
    } else {
      setHeaderRow(0);
      setCols({ codeCol: -1, costCol: -1, eanCol: -1, nameCol: -1 });
      setError("No encontré las columnas solas. Elegí cuál es el código, el EAN y el costo.");
    }
  }

  async function read(f: File, sheetName?: string) {
    setError("");
    setResult(null);
    if (f.size > 4 * 1024 * 1024) { setError("El archivo pesa más de 4 MB. Borrá las hojas que no hacen falta y volvé a subirlo."); return; }
    if (/\.xls$/i.test(f.name)) { setError("Es un Excel viejo (.xls). Guardalo como .xlsx o como CSV y volvé a subirlo."); return; }
    setLoading(true);
    try {
      if (isExcel(f)) {
        const form = new FormData();
        form.append("file", f);
        if (sheetName) form.append("sheet", sheetName);
        const res = await fetch("/api/products/import-costs/parse", { method: "POST", body: form });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error ?? `Error ${res.status}`);
        setSheets(data.sheets);
        setSheet(data.sheet);
        loadRows(data.rows, data.fileDate);
      } else {
        setSheets([]);
        setSheet("");
        loadRows(parseCsv(await readCsv(f)), null);
      }
    } catch (err) {
      setRows(null);
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function apply() {
    if (!preview) return;
    const byProduct = new Map<string, number>();
    for (const it of toSave) if (!byProduct.has(it.product.id)) byProduct.set(it.product.id, newCost(it));
    const payload = [...byProduct.entries()].map(([productId, cost]) => ({ productId, cost: Math.round(cost * 100) / 100 }));
    setError("");
    const total = { updated: 0, unchanged: 0, itemsUpdated: 0 };
    setProgress({ done: 0, total: payload.length });
    try {
      for (let i = 0; i < payload.length; i += CHUNK) {
        const res = await fetch("/api/products/import-costs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ items: payload.slice(i, i + CHUNK), validFrom }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error ?? `Error ${res.status}`);
        total.updated += data.updated;
        total.unchanged += data.unchanged;
        total.itemsUpdated += data.itemsUpdated;
        setProgress({ done: Math.min(i + CHUNK, payload.length), total: payload.length });
      }
      setResult(total);
      setRows(null);
      setFile(null);
      if (inputRef.current) inputRef.current.value = "";
      onDone();
    } catch (err) {
      setError(`Se cortó la carga: ${(err as Error).message}. Lo que ya se guardó queda; si volvés a subir el mismo archivo, sigue con lo que falta.`);
    } finally {
      setProgress(null);
    }
  }

  const colSelect = (label: string, key: keyof Cols, optional: boolean) => (
    <label className="field-hint" style={{ margin: 0 }}>
      {label}{" "}
      <select value={cols[key]} onChange={(e) => setCols({ ...cols, [key]: Number(e.target.value) })} style={{ padding: "5px 6px" }}>
        <option value={-1}>{optional ? "Ninguna" : "Elegir…"}</option>
        {headers.map((h, i) => <option key={i} value={i}>{String(h ?? "").trim() || `Columna ${i + 1}`}</option>)}
      </select>
    </label>
  );

  return (
    <details className="day-card" style={{ marginBottom: "var(--space-3)" }}>
      <summary style={{ cursor: "pointer", fontWeight: 600 }}>Importar costos desde Excel o CSV</summary>
      <div style={{ display: "grid", gap: "var(--space-2)", marginTop: "var(--space-3)" }}>
        <p className="field-hint" style={{ margin: 0 }}>
          Subí tu planilla de stock o tu lista de costos tal como la usás. Cruzamos cada artículo con tus publicaciones
          por <strong>código de barras (EAN)</strong> y, si no, por <strong>SKU</strong>. El costo es por unidad, en pesos.
          Antes de guardar vas a ver qué cambia y qué queda para cargar a mano.
        </p>
        {!hasCodes && (
          <p className="field-hint" style={{ margin: 0 }}>
            Todavía no tenemos los EAN de tus publicaciones: el cruce va a ser solo por SKU hasta la próxima sincronización.
          </p>
        )}
        <div>
          <label htmlFor="cost-file" className="field-hint" style={{ display: "block", marginBottom: 4 }}>Archivo (.xlsx o .csv)</label>
          <input
            id="cost-file"
            ref={inputRef}
            type="file"
            accept=".xlsx,.csv,.txt,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={(e) => { const f = e.target.files?.[0] ?? null; setFile(f); if (f) read(f); }}
          />
          {loading && <span className="field-hint"> Leyendo…</span>}
        </div>

        {rows && (
          <div style={{ display: "flex", gap: "var(--space-3)", flexWrap: "wrap", alignItems: "center" }}>
            {sheets.length > 1 && (
              <label className="field-hint" style={{ margin: 0 }}>
                Hoja{" "}
                <select value={sheet} onChange={(e) => file && read(file, e.target.value)} style={{ padding: "5px 6px" }}>
                  {sheets.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </label>
            )}
            {colSelect("Código", "codeCol", true)}
            {colSelect("EAN", "eanCol", true)}
            {colSelect("Costo unitario", "costCol", false)}
            <label className="field-hint" style={{ margin: 0 }}>
              Costo vigente desde{" "}
              <input type="date" value={validFrom} max={today()} onChange={(e) => setValidFrom(e.target.value || today())} style={{ padding: "4px 6px" }} />
            </label>
          </div>
        )}

        {error && <p className="field-error" role="alert" style={{ margin: 0 }}>{error}</p>}

        {preview && extracted && (
          <div style={{ display: "grid", gap: "var(--space-2)" }}>
            <p style={{ margin: 0 }}>
              {extracted.rows.length} artículos con costo en la planilla. Coinciden con <strong>{new Set(items.map((it) => it.product.id)).size}</strong>{" "}
              publicaciones ({items.filter((it) => it.by === "ean").length} cruces por EAN y {items.filter((it) => it.by === "sku").length} por SKU).{" "}
              {preview.notFound.length} artículos no están publicados o no coinciden.
              {extracted.skipped > 0 && ` Se ignoraron ${extracted.skipped} filas de títulos, totales o artículos sin costo.`}
            </p>
            <p className="field-hint" style={{ margin: 0 }}>
              Quedan sin marcar los cruces para revisar: cuando el nombre del artículo no se parece al de la publicación
              (pasa cuando un mismo EAN o SKU se usa en publicaciones distintas) o cuando una publicación coincide con
              varios artículos de costos distintos. Si la publicación es un pack (&quot;Set X6&quot;, &quot;Pack de 20&quot;), el costo se
              multiplica por esas unidades: revisá el número en la columna Unid.
            </p>
            {extracted.duplicates.length > 0 && (
              <p className="field-hint" style={{ margin: 0 }}>
                Artículos repetidos con costos distintos (se usó el último): {extracted.duplicates.slice(0, 8).join(", ")}
                {extracted.duplicates.length > 8 ? "…" : ""}
              </p>
            )}
            <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
              <button type="button" className={`btn btn-sm ${filter === "review" ? "btn-primary" : "btn-secondary"}`} onClick={() => setFilter("review")}>
                Para revisar ({review.length})
              </button>
              <button type="button" className={`btn btn-sm ${filter === "all" ? "btn-primary" : "btn-secondary"}`} onClick={() => setFilter("all")}>
                Todos ({items.length})
              </button>
            </div>
            {shown.length > 0 && (
              <div className="table-wrap" style={{ maxHeight: 520, overflowY: "auto" }}>
                <table>
                  <thead>
                    <tr>
                      <th aria-label="Aplicar" />
                      <th>Artículo de la planilla</th>
                      <th>Publicación</th>
                      <th>Por</th>
                      <th>Revisar</th>
                      <th className="num">Unid.</th>
                      <th className="num">Costo actual</th>
                      <th className="num">Costo nuevo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((it) => {
                      const flags = [
                        !it.nameOk && "El nombre no se parece",
                        it.conflict && "Varios artículos con costos distintos",
                        dupSelected.has(it.product.id) && selected.has(it.key) && "Marcado dos veces: se usa el primero",
                      ].filter(Boolean);
                      return (
                        <tr key={it.key} style={selected.has(it.key) ? undefined : { opacity: 0.6 }}>
                          <td>
                            <input type="checkbox" aria-label={`Aplicar ${it.row.rawCode} a ${it.product.title}`} checked={selected.has(it.key)} onChange={() => toggle(it.key)} />
                          </td>
                          <td>{it.row.rawCode || it.row.ean}{it.row.name ? <span className="field-hint"> {it.row.name}</span> : null}</td>
                          <td>{it.product.title}</td>
                          <td>{it.by === "ean" ? "EAN" : "SKU"}</td>
                          <td><span className={flags.length ? "field-error" : "field-hint"} style={{ margin: 0 }}>{flags.length ? flags.join(" · ") : "OK"}</span></td>
                          <td className="num">
                            <input
                              type="number"
                              min={1}
                              step={1}
                              aria-label="Unidades por publicación"
                              value={unitsOf(it)}
                              onChange={(e) => setUnits((u) => ({ ...u, [it.key]: Math.max(1, Math.round(Number(e.target.value) || 1)) }))}
                              style={{ width: 64, padding: "3px 4px" }}
                            />
                          </td>
                          <td className="num">{it.product.currentCost === null ? "—" : fmt(it.product.currentCost)}</td>
                          <td className="num">{fmt(newCost(it))}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {preview.stillWithoutCost.length > 0 && (
              <details>
                <summary className="field-hint" style={{ cursor: "pointer" }}>
                  {preview.stillWithoutCost.length} publicación(es) sin costo no coinciden con ningún artículo: cargalas a mano en la tabla de abajo
                </summary>
                <p className="field-hint">
                  Suele pasar cuando la publicación no tiene EAN ni SKU cargado en Mercado Libre, o el código es distinto al de tu planilla.{" "}
                  {preview.stillWithoutCost.slice(0, 30).map((p) => p.title).join("; ")}
                  {preview.stillWithoutCost.length > 30 ? "…" : ""}
                </p>
              </details>
            )}
            <div>
              <button type="button" className="btn btn-primary" disabled={toSave.length === 0 || progress !== null} onClick={apply}>
                {progress ? `Guardando ${progress.done} de ${progress.total}…` : `Guardar ${new Set(toSave.map((it) => it.product.id)).size} costo(s) marcados`}
              </button>
            </div>
          </div>
        )}

        {result && (
          <p role="status" style={{ margin: 0 }}>
            Listo: {result.updated} costo(s) guardado(s){result.unchanged ? `, ${result.unchanged} sin cambios` : ""}. Se recalcularon {result.itemsUpdated} líneas de venta.
          </p>
        )}
      </div>
    </details>
  );
}
