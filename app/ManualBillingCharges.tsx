"use client";

import { useEffect, useState } from "react";
import { BUCKET_LABEL, CHARGE_BUCKETS } from "@/sync/billing";
import { toDateStr } from "@/lib/period";

interface ManualCharge {
  id: string;
  date: string;
  bucket: string;
  label: string;
  description: string | null;
  amount: number;
}

function fmt(n: number) {
  return n.toLocaleString("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 });
}

/**
 * Cargos de la factura de Mercado Libre que el vendedor carga a mano porque
 * no llegan por la API de facturación. Se guardan junto a los sincronizados
 * y suman en la tabla "Lo que Mercado Libre te facturó" (onChange la recarga).
 */
export function ManualBillingCharges({ from, to, onChange }: { from: string; to: string; onChange: () => void }) {
  const [charges, setCharges] = useState<ManualCharge[] | null>(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ date: toDateStr(new Date()), bucket: "otro", amount: "", description: "" });
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  function load() {
    fetch(`/api/billing/manual?from=${from}&to=${to}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: ManualCharge[]) => setCharges(rows))
      .catch(() => setCharges([]));
  }

  useEffect(load, [from, to]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaved(false);
    const amount = Number(form.amount.replace(",", "."));
    if (form.amount.trim() === "" || !Number.isFinite(amount) || amount === 0) {
      setError("Ingresá un importe distinto de 0.");
      return;
    }
    setBusy(true);
    try {
      const r = await fetch("/api/billing/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date: form.date, bucket: form.bucket, amount, description: form.description }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        setError(body.error ?? "No se pudo guardar. Probá de nuevo.");
        return;
      }
      setForm((p) => ({ ...p, amount: "", description: "" }));
      setSaved(true);
      load();
      onChange();
    } finally {
      setBusy(false);
    }
  }

  async function remove(charge: ManualCharge) {
    if (!window.confirm(`¿Borrar el cargo de ${fmt(charge.amount)} del ${charge.date}?`)) return;
    const r = await fetch(`/api/billing/manual?id=${encodeURIComponent(charge.id)}`, { method: "DELETE" });
    if (!r.ok) {
      window.alert("No se pudo borrar el cargo. Probá de nuevo.");
      return;
    }
    load();
    onChange();
  }

  return (
    <>
      {charges && charges.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Cargado a mano</th>
                <th>Fecha</th>
                <th>Detalle</th>
                <th className="num">Importe</th>
                <th aria-label="Acciones" />
              </tr>
            </thead>
            <tbody>
              {charges.map((c) => (
                <tr key={c.id}>
                  <td>{c.label}</td>
                  <td>{c.date}</td>
                  <td style={{ color: "var(--text-dim)" }}>{c.description ?? "—"}</td>
                  <td className="num">{fmt(c.amount)}</td>
                  <td className="num">
                    <button type="button" className="btn btn-secondary" onClick={() => remove(c)}>
                      Borrar
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!open ? (
        <button type="button" className="btn btn-secondary" style={{ marginBottom: "var(--space-5)" }} onClick={() => setOpen(true)}>
          + Agregar una factura de ML a mano
        </button>
      ) : (
        <form className="ad-form" onSubmit={submit} noValidate>
          <label>
            Fecha
            <input type="date" value={form.date} onChange={(e) => setForm((p) => ({ ...p, date: e.target.value }))} />
          </label>
          <label>
            Concepto
            <select value={form.bucket} onChange={(e) => setForm((p) => ({ ...p, bucket: e.target.value }))}>
              {CHARGE_BUCKETS.map((b) => (
                <option key={b} value={b}>{BUCKET_LABEL[b]}</option>
              ))}
            </select>
          </label>
          <div className="field-group">
            <label htmlFor="manual-charge-amount">Importe</label>
            <input
              id="manual-charge-amount"
              type="number"
              inputMode="decimal"
              aria-invalid={error ? true : undefined}
              value={form.amount}
              onChange={(e) => {
                setForm((p) => ({ ...p, amount: e.target.value }));
                if (error) setError("");
              }}
            />
          </div>
          <label>
            Detalle (opcional)
            <input
              type="text"
              maxLength={200}
              placeholder="Ej: N° de factura"
              value={form.description}
              onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))}
            />
          </label>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? "Guardando…" : "Agregar"}
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => { setOpen(false); setError(""); setSaved(false); }}>
            Cerrar
          </button>
          {error && <p className="field-error" role="alert" style={{ width: "100%", margin: 0 }}>{error}</p>}
          {saved && (
            <span role="status" aria-live="polite" className="success-text">
              Cargo agregado.
            </span>
          )}
          <p style={{ width: "100%", margin: 0, fontSize: 12, color: "var(--text-dim)" }}>
            Para las facturas que Mercado Libre te mandó y no aparecen arriba. Si es una nota de crédito, cargala en
            negativo. Se suma en la tabla según la fecha que elijas.
          </p>
        </form>
      )}
    </>
  );
}
