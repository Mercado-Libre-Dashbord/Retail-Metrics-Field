"use client";

import { useEffect, useState } from "react";
import { TRIAL_STATUSES, type TrialStatus } from "@/lib/trial-request";
import type { TrialRequest } from "@/db/trial-requests";

const STATUS_LABEL: Record<TrialStatus, string> = {
  nueva: "Nueva",
  contactada: "Contactada",
  activada: "Activada",
  descartada: "Descartada",
};

/** Solicitudes de prueba que llegan desde la landing, con la campaña que las
 * trajo. "Crear cuenta" completa el formulario de Nueva cuenta de arriba. */
export function TrialRequests({ onCreateAccount }: { onCreateAccount: (name: string, email: string) => void }) {
  const [rows, setRows] = useState<TrialRequest[] | null>(null);
  const [error, setError] = useState("");

  function load() {
    fetch("/api/trial-requests")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((data) => setRows(data.requests ?? []))
      .catch(() => setError("No se pudieron cargar las solicitudes."));
  }
  useEffect(load, []);

  async function setStatus(id: number, status: TrialStatus) {
    setRows((prev) => prev?.map((r) => (r.id === id ? { ...r, status } : r)) ?? prev);
    const res = await fetch("/api/trial-requests", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, status }),
    });
    if (!res.ok) {
      setError("No se pudo cambiar el estado.");
      load();
    }
  }

  const pending = rows?.filter((r) => r.status === "nueva").length ?? 0;

  return (
    <>
      <h2 className="section-title">
        Solicitudes de prueba{pending > 0 ? ` · ${pending} nueva${pending === 1 ? "" : "s"}` : ""}
      </h2>
      {error && <p className="field-error">{error}</p>}
      {rows === null && !error && <p className="field-hint">Cargando…</p>}
      {rows?.length === 0 && <div className="empty-state">Todavía no llegó ninguna solicitud desde la landing.</div>}
      {rows && rows.length > 0 && (
        <div className="table-wrap" style={{ marginBottom: 24 }}>
          <table>
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Nombre</th>
                <th>Email</th>
                <th>Tienda</th>
                <th>Ventas/mes</th>
                <th>WhatsApp</th>
                <th>Campaña</th>
                <th>Estado</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{new Date(r.createdAt).toLocaleDateString("es-AR")}</td>
                  <td>{r.name}</td>
                  <td>{r.email}</td>
                  <td>{r.store}</td>
                  <td>{r.monthlySales ?? "—"}</td>
                  <td>{r.phone ?? "—"}</td>
                  <td>{[r.utmSource, r.utmCampaign, r.utmContent].filter(Boolean).join(" / ") || "directo"}</td>
                  <td>
                    <select
                      aria-label={`Estado de ${r.name}`}
                      value={r.status}
                      onChange={(e) => setStatus(r.id, e.target.value as TrialStatus)}
                    >
                      {TRIAL_STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {STATUS_LABEL[s]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => onCreateAccount(r.store, r.email)}>
                      Crear cuenta
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
