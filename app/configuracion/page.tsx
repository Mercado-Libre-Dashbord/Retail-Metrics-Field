"use client";

import { useEffect, useState } from "react";
import { NoAccountState } from "../NoAccountState";
import { IvaPaid } from "./IvaPaid";

type TaxCondition = "responsable_inscripto" | "monotributo" | "exento";

const TAX_CONDITION_LABEL: Record<TaxCondition, string> = {
  responsable_inscripto: "Responsable Inscripto",
  monotributo: "Monotributista",
  exento: "Exento",
};

export default function ConfiguracionPage() {
  const [rate, setRate] = useState("");
  const [taxCondition, setTaxCondition] = useState<TaxCondition>("responsable_inscripto");
  // El régimen que está guardado (no el que está elegido en el desplegable):
  // decide si se puede cargar el IVA pagado.
  const [savedTaxCondition, setSavedTaxCondition] = useState<TaxCondition>("responsable_inscripto");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [noAccount, setNoAccount] = useState(false);

  useEffect(() => {
    fetch("/api/account/settings").then(async (r) => {
      if (r.status === 401) { setNoAccount(true); return; }
      const data = await r.json();
      // Se guarda como fracción (0.03) y se edita como porcentaje (3).
      setRate(String((Number(data.otherTaxRate ?? 0) * 100).toFixed(2).replace(/\.?0+$/, "")));
      if (data.taxCondition) {
        setTaxCondition(data.taxCondition);
        setSavedTaxCondition(data.taxCondition);
      }
      setLoaded(true);
    }).catch(() => {
      setError("No se pudo cargar la configuración.");
      setLoaded(true);
    });
  }, []);

  if (noAccount) {
    return (
      <div>
        <h1>Configuración</h1>
        <NoAccountState />
      </div>
    );
  }

  async function save() {
    const percent = Number(rate.replace(",", "."));
    if (rate.trim() === "" || Number.isNaN(percent) || percent < 0 || percent > 100) {
      setError("Ingresá un porcentaje entre 0 y 100.");
      return;
    }
    setError("");
    setSaved(false);
    setSaving(true);
    try {
      const res = await fetch("/api/account/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ otherTaxRate: percent / 100, taxCondition }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "No se pudo guardar."); return; }
      setSaved(true);
      setSavedTaxCondition(taxCondition);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <h1>Configuración</h1>

      <h2 className="section-title">Régimen fiscal</h2>
      <div className="day-card" style={{ maxWidth: 620 }}>
        <div className="field-group" style={{ maxWidth: 280 }}>
          <label className="field-hint" htmlFor="tax-condition">Tu condición ante IVA</label>
          <select
            id="tax-condition"
            value={taxCondition}
            onChange={(e) => { setTaxCondition(e.target.value as TaxCondition); setSaved(false); }}
            disabled={!loaded}
          >
            {(Object.keys(TAX_CONDITION_LABEL) as TaxCondition[]).map((key) => (
              <option key={key} value={key}>{TAX_CONDITION_LABEL[key]}</option>
            ))}
          </select>
        </div>
        <p className="field-hint" style={{ marginTop: "var(--space-2)", marginBottom: 0 }}>
          {taxCondition === "responsable_inscripto"
            ? "Calculamos el IVA de tus ventas (débito menos crédito) y lo descontamos de tu ganancia neta."
            : "No se calcula IVA sobre tus ventas: tu régimen no lo discrimina en el precio."}
        </p>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", marginTop: "var(--space-4)" }}>
          <button className="btn btn-primary" onClick={save} disabled={saving || !loaded}>
            {saving ? "Guardando…" : "Guardar"}
          </button>
          {saved && (
            <span role="status" aria-live="polite" className="success-text">
              Guardado.
            </span>
          )}
        </div>
      </div>

      <h2 className="section-title">Impuestos</h2>
      <div className="day-card" style={{ maxWidth: 620 }}>
        <div className="field-group" style={{ maxWidth: 220 }}>
          <label className="field-hint" htmlFor="other-tax">Otros impuestos (% de la facturación)</label>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
            <input
              id="other-tax"
              type="number"
              min="0"
              max="100"
              step="0.01"
              inputMode="decimal"
              aria-invalid={error ? true : undefined}
              value={rate}
              onChange={(e) => { setRate(e.target.value); setError(""); setSaved(false); }}
              disabled={!loaded}
              style={{ width: 110 }}
            />
            <span style={{ color: "var(--text-dim)" }}>%</span>
          </div>
          {error && <p className="field-error" role="alert">{error}</p>}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", marginTop: "var(--space-3)" }}>
          <button className="btn btn-primary" onClick={save} disabled={saving || !loaded}>
            {saving ? "Guardando…" : "Guardar"}
          </button>
          {saved && (
            <span role="status" aria-live="polite" className="success-text">
              Guardado. Apretá &quot;Sincronizar&quot; en Resumen para aplicarlo a las ventas ya sincronizadas.
            </span>
          )}
        </div>

        <details className="explain-box" style={{ marginTop: "var(--space-4)", marginBottom: 0 }}>
          <summary>¿Qué va acá y qué no?</summary>
          <ul>
            <li>
              <strong>Sí</strong>: Ingresos Brutos, impuestos internos, cualquier alícuota que pagues sobre lo que
              facturás. Se aplica igual a todos tus productos.
            </li>
            <li>
              <strong>No</strong>: el IVA. Se calcula al 21% sobre cada venta —descontando el crédito de la
              comisión, el envío, la publicidad y el costo— solo si arriba tenés marcado "Responsable
              Inscripto", o con el IVA real que cargues abajo. Si lo cargás acá también lo estarías contando
              dos veces.
            </li>
          </ul>
          <p>
            Antes esto se cargaba producto por producto. Es una alícuota que depende de tu jurisdicción, no del
            artículo, así que se configura una sola vez para toda la cuenta.
          </p>
        </details>
      </div>

      {loaded && (
        <IvaPaid
          key={savedTaxCondition}
          appliesIva={savedTaxCondition === "responsable_inscripto"}
          conditionLabel={TAX_CONDITION_LABEL[savedTaxCondition]}
        />
      )}
    </div>
  );
}
