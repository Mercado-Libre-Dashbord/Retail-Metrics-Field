"use client";

import { useEffect, useState } from "react";
import type { IvaMonth } from "@/sync/iva-payments";

const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const monthLabel = (period: string) => {
  const [y, m] = period.split("-");
  return `${MONTHS[Number(m) - 1]} ${y}`;
};
const money = (n: number) => `$${Math.round(n).toLocaleString("es-AR")}`;
const pct = (n: number) => `${(n * 100).toFixed(2).replace(".", ",")}%`;

/**
 * IVA que el vendedor pagó de verdad, mes por mes. Con ese monto se calcula
 * el % efectivo del mes y se aplica a sus ventas; los meses sin cargar usan
 * el % del último mes cargado.
 */
export function IvaPaid({ appliesIva, conditionLabel }: { appliesIva: boolean; conditionLabel: string }) {
  const [months, setMonths] = useState<IvaMonth[] | null>(null);
  const [available, setAvailable] = useState(true);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingPeriod, setSavingPeriod] = useState<string | null>(null);
  const [message, setMessage] = useState<{ period: string; text: string; error?: boolean } | null>(null);

  useEffect(() => {
    fetch("/api/account/iva")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((data) => {
        setMonths(data.months ?? []);
        setAvailable(data.available !== false);
      })
      .catch(() => setMonths([]));
  }, []);

  const loadedRates = (months ?? []).filter((m) => m.effectiveRate !== null);
  /** % que se usa en un mes sin monto: el del último mes cargado anterior, o el primero cargado. */
  const rateFor = (period: string) => {
    // Cuentas que no son Responsable Inscripto: los meses sin cargar no se estiman.
    if (!appliesIva) return null;
    const prior = loadedRates.filter((m) => m.period <= period).sort((a, b) => b.period.localeCompare(a.period))[0];
    const first = [...loadedRates].sort((a, b) => a.period.localeCompare(b.period))[0];
    return prior ?? first ?? null;
  };

  async function save(period: string, clear = false) {
    const raw = (drafts[period] ?? "").replace(/\./g, "").replace(",", ".").replace(/[^0-9.]/g, "");
    const amount = clear ? null : Number(raw);
    if (!clear && (raw === "" || !Number.isFinite(amount))) {
      setMessage({ period, text: "Ingresá el monto en pesos.", error: true });
      return;
    }
    setSavingPeriod(period);
    setMessage(null);
    try {
      const res = await fetch("/api/account/iva", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ period, amount }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage({ period, text: data.error ?? "No se pudo guardar.", error: true });
        return;
      }
      setMonths(data.months);
      setDrafts((d) => ({ ...d, [period]: "" }));
      setMessage({ period, text: clear ? "Borrado. Se recalcularon tus ventas." : "Guardado. Se recalcularon tus ventas." });
    } finally {
      setSavingPeriod(null);
    }
  }

  return (
    <>
      <h2 className="section-title">IVA que pagaste</h2>
      <div className="day-card" style={{ maxWidth: 880 }}>
        <p className="field-hint" style={{ marginTop: 0 }}>
          Cargá el IVA que pagaste cada mes (el saldo que te pasa tu contador). Calculamos tu % de IVA real sobre lo
          que facturaste ese mes y lo usamos en tus ventas.{" "}
          {appliesIva
            ? "Los meses que no cargues usan el % del último mes cargado."
            : `Tu régimen figura como ${conditionLabel}: solo se descuenta el IVA de los meses que cargues acá; los demás meses quedan sin IVA.`}
        </p>
        {!available && (
          <p className="field-error" role="alert">
            Falta correr la migración db/postgres/migrations/022-iva-pagado.sql.
          </p>
        )}
        {months === null && <p className="field-hint">Cargando…</p>}
        {months && months.length === 0 && <div className="empty-state">Todavía no hay ventas sincronizadas.</div>}
        {months && months.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Mes</th>
                  <th style={{ textAlign: "right" }}>Facturación</th>
                  <th style={{ textAlign: "right" }}>IVA aplicado hoy</th>
                  <th>IVA que pagaste</th>
                  <th style={{ textAlign: "right" }}>% de IVA</th>
                </tr>
              </thead>
              <tbody>
                {months.map((m) => {
                  const source = m.paid !== null ? null : rateFor(m.period);
                  return (
                    <tr key={m.period}>
                      <td style={{ textTransform: "capitalize" }}>{monthLabel(m.period)}</td>
                      <td style={{ textAlign: "right" }}>{money(m.revenue)}</td>
                      <td style={{ textAlign: "right" }}>{money(m.applied)}</td>
                      <td style={{ minWidth: 300 }}>
                        <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "center" }}>
                          <input
                            aria-label={`IVA pagado en ${monthLabel(m.period)}`}
                            inputMode="decimal"
                            placeholder={m.paid !== null ? money(m.paid) : "$ monto"}
                            value={drafts[m.period] ?? ""}
                            onChange={(e) => setDrafts((d) => ({ ...d, [m.period]: e.target.value }))}
                            onKeyDown={(e) => e.key === "Enter" && save(m.period)}
                            disabled={!available || savingPeriod !== null}
                            style={{ width: 120, padding: "6px 8px", minHeight: 32 }}
                          />
                          <button
                            className="btn btn-secondary btn-sm"
                            onClick={() => save(m.period)}
                            disabled={!available || savingPeriod !== null || !(drafts[m.period] ?? "").trim()}
                          >
                            {savingPeriod === m.period ? "Guardando…" : "Guardar"}
                          </button>
                          {m.paid !== null && (
                            <button
                              className="btn btn-secondary btn-sm"
                              onClick={() => save(m.period, true)}
                              disabled={savingPeriod !== null}
                              aria-label={`Borrar el IVA cargado de ${monthLabel(m.period)}`}
                            >
                              Borrar
                            </button>
                          )}
                        </div>
                        {message?.period === m.period && (
                          <p className={message.error ? "field-error" : "success-text"} role="status">
                            {message.text}
                          </p>
                        )}
                      </td>
                      <td style={{ textAlign: "right" }}>
                        {m.effectiveRate !== null ? (
                          <strong>{pct(m.effectiveRate)}</strong>
                        ) : source?.effectiveRate != null ? (
                          <span className="field-hint" title={`Estimado con el % de ${monthLabel(source.period)}`}>
                            {pct(source.effectiveRate)} (estimado)
                          </span>
                        ) : (
                          <span className="field-hint">{appliesIva ? "21% teórico" : "sin IVA"}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
