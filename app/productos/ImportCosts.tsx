"use client";

import { useMemo, useRef, useState } from "react";
import {
  buildPreview,
  detectColumns,
  extractRows,
  parseCsv,
  type ProductRef,
} from "@/lib/cost-import";

const CHUNK = 25;

const fmt = (n: number) => n.toLocaleString("es-AR", { style: "currency", currency: "ARS", minimumFractionDigits: 2 });

/** Excel guarda en Windows-1252 si no se elige UTF-8: si el texto trae caracteres rotos se vuelve a leer así. */
async function readFile(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const utf8 = new TextDecoder("utf-8").decode(buffer);
  return utf8.includes("�") ? new TextDecoder("windows-1252").decode(buffer) : utf8;
}

export function ImportCosts({ products, onDone }: { products: ProductRef[]; onDone: () => void }) {
  const [rows, setRows] = useState<string[][] | null>(null);
  const [fileName, setFileName] = useState("");
  const [headerRow, setHeaderRow] = useState(0);
  const [codeCol, setCodeCol] = useState(-1);
  const [costCol, setCostCol] = useState(-1);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<{ updated: number; unchanged: number; missing: number; itemsUpdated: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const headers = rows?.[headerRow] ?? [];
  const extracted = useMemo(
    () => (rows && codeCol >= 0 && costCol >= 0 ? extractRows(rows, headerRow, codeCol, costCol) : null),
    [rows, headerRow, codeCol, costCol]
  );
  const preview = useMemo(() => (extracted ? buildPreview(extracted.rows, products) : null), [extracted, products]);
  const toApply = preview ? preview.toUpdate.reduce((n, i) => n + i.products.length, 0) : 0;

  async function onFile(file: File | undefined) {
    setError("");
    setResult(null);
    setProgress(null);
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { setError("El archivo pesa más de 5 MB. Probá con un CSV más chico."); return; }
    if (/\.xlsx?$/i.test(file.name)) {
      setError("Guardalo como CSV desde Excel (Archivo → Guardar como → CSV) y volvé a subirlo.");
      return;
    }
    const parsed = parseCsv(await readFile(file));
    const detected = detectColumns(parsed);
    setFileName(file.name);
    setRows(parsed);
    if (detected) {
      setHeaderRow(detected.headerRow);
      setCodeCol(detected.codeCol);
      setCostCol(detected.costCol);
    } else {
      setHeaderRow(0);
      setCodeCol(-1);
      setCostCol(-1);
      setError("No encontré las columnas solas. Elegí cuál es el código y cuál es el costo.");
    }
  }

  async function apply() {
    if (!preview) return;
    const items = preview.toUpdate.flatMap((i) => i.products.map((p) => ({ productId: p.id, cost: i.cost })));
    setError("");
    const total = { updated: 0, unchanged: 0, missing: 0, itemsUpdated: 0 };
    setProgress({ done: 0, total: items.length });
    try {
      for (let i = 0; i < items.length; i += CHUNK) {
        const res = await fetch("/api/products/import-costs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ items: items.slice(i, i + CHUNK) }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error ?? `Error ${res.status}`);
        total.updated += data.updated;
        total.unchanged += data.unchanged;
        total.missing += data.missing;
        total.itemsUpdated += data.itemsUpdated;
        setProgress({ done: Math.min(i + CHUNK, items.length), total: items.length });
      }
      setResult(total);
      setRows(null);
      if (inputRef.current) inputRef.current.value = "";
      onDone();
    } catch (err) {
      setError(`Se cortó la carga: ${(err as Error).message}. Lo que ya se aplicó queda guardado; podés volver a subir el mismo archivo y sigue donde quedó.`);
    } finally {
      setProgress(null);
    }
  }

  return (
    <details className="day-card" style={{ marginBottom: "var(--space-3)" }}>
      <summary style={{ cursor: "pointer", fontWeight: 600 }}>Importar costos desde un CSV</summary>
      <div style={{ display: "grid", gap: "var(--space-2)", marginTop: "var(--space-3)" }}>
        <p className="field-hint" style={{ margin: 0 }}>
          Subí tu lista de costos (por ejemplo, la del proveedor guardada como CSV). Cruzamos cada fila con tus
          publicaciones por <strong>SKU</strong> (el código que tenés en Mercado Libre como “SKU” o “código
          interno”) o por ID de publicación. El costo es por unidad, en pesos. Antes de guardar vas a ver qué va a cambiar.
        </p>
        <div>
          <label htmlFor="cost-csv" className="field-hint" style={{ display: "block", marginBottom: 4 }}>Archivo CSV</label>
          <input id="cost-csv" ref={inputRef} type="file" accept=".csv,.txt,text/csv" onChange={(e) => onFile(e.target.files?.[0])} />
        </div>

        {rows && (
          <div style={{ display: "flex", gap: "var(--space-3)", flexWrap: "wrap" }}>
            <label className="field-hint" style={{ margin: 0 }}>
              Columna del código{" "}
              <select value={codeCol} onChange={(e) => setCodeCol(Number(e.target.value))} style={{ padding: "5px 6px" }}>
                <option value={-1}>Elegir…</option>
                {headers.map((h, i) => <option key={i} value={i}>{h.trim() || `Columna ${i + 1}`}</option>)}
              </select>
            </label>
            <label className="field-hint" style={{ margin: 0 }}>
              Columna del costo unitario{" "}
              <select value={costCol} onChange={(e) => setCostCol(Number(e.target.value))} style={{ padding: "5px 6px" }}>
                <option value={-1}>Elegir…</option>
                {headers.map((h, i) => <option key={i} value={i}>{h.trim() || `Columna ${i + 1}`}</option>)}
              </select>
            </label>
          </div>
        )}

        {error && <p className="field-error" role="alert" style={{ margin: 0 }}>{error}</p>}

        {preview && extracted && (
          <div style={{ display: "grid", gap: "var(--space-2)" }}>
            <p style={{ margin: 0 }}>
              <strong>{fileName}</strong>: {extracted.rows.length} códigos con costo.{" "}
              <strong>{toApply}</strong> publicación(es) se van a actualizar, {preview.unchanged.length} ya tienen ese costo
              y {preview.notFound.length} no coinciden con ninguna publicación.
              {extracted.skipped > 0 && ` Se ignoraron ${extracted.skipped} filas sin código o sin costo (títulos, rubros, artículos sin costo).`}
            </p>
            {extracted.duplicates.length > 0 && (
              <p className="field-hint" style={{ margin: 0 }}>
                Códigos repetidos con costos distintos (se usó el último): {extracted.duplicates.slice(0, 8).join(", ")}
                {extracted.duplicates.length > 8 ? "…" : ""}
              </p>
            )}
            {preview.toUpdate.length > 0 && (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>Código</th><th>Publicación</th><th className="num">Costo actual</th><th className="num">Costo nuevo</th></tr>
                  </thead>
                  <tbody>
                    {preview.toUpdate.slice(0, 10).map((i) => (
                      <tr key={i.code}>
                        <td>{i.code}</td>
                        <td>{i.products[0].title}{i.products.length > 1 ? ` (+${i.products.length - 1} más)` : ""}</td>
                        <td className="num">{i.products[0].currentCost === null ? "—" : fmt(i.products[0].currentCost)}</td>
                        <td className="num">{fmt(i.cost)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {preview.toUpdate.length > 10 && <p className="field-hint">Y {preview.toUpdate.length - 10} más.</p>}
              </div>
            )}
            {preview.notFound.length > 0 && (
              <details>
                <summary className="field-hint" style={{ cursor: "pointer" }}>Ver los {preview.notFound.length} códigos sin coincidencia</summary>
                <p className="field-hint">
                  Suelen ser artículos que no publicaste o publicaciones sin SKU cargado en Mercado Libre.{" "}
                  {preview.notFound.slice(0, 40).map((r) => r.code).join(", ")}
                  {preview.notFound.length > 40 ? "…" : ""}
                </p>
              </details>
            )}
            <div>
              <button type="button" className="btn btn-primary" disabled={toApply === 0 || progress !== null} onClick={apply}>
                {progress ? `Guardando ${progress.done} de ${progress.total}…` : `Guardar ${toApply} costo(s)`}
              </button>
            </div>
          </div>
        )}

        {result && (
          <p role="status" style={{ margin: 0 }}>
            Listo: {result.updated} costo(s) guardado(s), {result.unchanged} sin cambios. Se recalcularon {result.itemsUpdated} líneas de venta.
          </p>
        )}
      </div>
    </details>
  );
}
