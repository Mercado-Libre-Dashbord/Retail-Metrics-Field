"use client";

import { useEffect, useState } from "react";

const PLACEHOLDER = `Por ejemplo:
- Despachamos en 24 h hábiles. Los envíos Full llegan en 24-48 h.
- Hacemos factura A y B.
- Garantía de 6 meses por falla de fábrica.
- No hay retiro en persona.
- Respondemos de lunes a viernes de 9 a 18.
- Firmamos "Saludos, equipo Casa Norte".`;

/**
 * Lo que la IA tiene que saber de la tienda para responder consultas, además
 * de lo que ya dice cada publicación.
 */
export function AnswerInfo() {
  const [text, setText] = useState("");
  const [state, setState] = useState<{ available: boolean; aiEnabled: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);

  useEffect(() => {
    fetch("/api/account/answer-info")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => {
        setText(d.sellerInfo ?? "");
        setState({ available: d.available !== false, aiEnabled: Boolean(d.aiEnabled) });
      })
      .catch(() => setState({ available: false, aiEnabled: false }));
  }, []);

  async function save() {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/account/answer-info", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sellerInfo: text }),
      });
      const data = await res.json().catch(() => ({}));
      setMessage(res.ok ? { text: "Guardado. Se usa desde la próxima consulta." } : { text: data.error ?? "No se pudo guardar.", error: true });
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <h2 className="section-title" id="respuestas">Respuestas a consultas</h2>
      <div className="day-card" style={{ maxWidth: 620 }}>
        <p className="field-hint" style={{ marginTop: 0 }}>
          La IA arma cada respuesta con la ficha, la descripción y las respuestas anteriores de la publicación. Acá
          contale lo que vale para toda la tienda: envíos, factura, garantía, retiro, horarios, cómo firmás.
          Si una consulta no se puede responder con esto, te la deja marcada para revisar.
        </p>
        <div className="field-group">
          <label className="field-hint" htmlFor="answer-info">Información de tu tienda</label>
          <textarea
            id="answer-info"
            rows={8}
            maxLength={4000}
            placeholder={PLACEHOLDER}
            value={text}
            disabled={!state?.available}
            onChange={(e) => { setText(e.target.value); setMessage(null); }}
            style={{
              width: "100%",
              background: "var(--surface)",
              border: "1px solid var(--border)",
              color: "var(--text)",
              borderRadius: "var(--radius-sm)",
              padding: "9px 10px",
              fontFamily: "inherit",
              fontSize: 14,
              resize: "vertical",
            }}
          />
          <p className="field-hint" style={{ margin: "var(--space-1) 0 0" }}>
            No pongas teléfonos, emails ni links: Mercado Libre no permite pasarlos en las respuestas.
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", marginTop: "var(--space-3)", flexWrap: "wrap" }}>
          <button className="btn btn-primary" onClick={save} disabled={saving || !state?.available}>
            {saving ? "Guardando…" : "Guardar"}
          </button>
          {message && (
            <span role="status" aria-live="polite" className={message.error ? "field-error" : "success-text"}>
              {message.text}
            </span>
          )}
        </div>
        {state && !state.available && (
          <p className="field-hint" style={{ marginBottom: 0 }}>Falta correr la migración 024-respuestas-con-ia.sql.</p>
        )}
        {state?.available && !state.aiEnabled && (
          <p className="field-hint" style={{ marginBottom: 0 }}>
            Las respuestas con IA todavía no están activadas en esta instalación. Mientras tanto se usan los borradores automáticos de siempre.
          </p>
        )}
      </div>
    </>
  );
}
