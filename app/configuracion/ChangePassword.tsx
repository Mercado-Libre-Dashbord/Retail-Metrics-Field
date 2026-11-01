"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";

/** Cambiar la contraseña desde adentro: manda el mismo link que "¿Olvidaste tu contraseña?". */
export function ChangePassword() {
  const { data: session } = useSession();
  const email = session?.user?.email ?? "";
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  if (!email) return null;

  async function send() {
    setLoading(true);
    setMessage(null);
    try {
      const res = await fetch("/api/password-reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json().catch(() => ({}));
      setMessage(res.ok ? { text: `Listo: te mandamos el link a ${email}. Revisá también spam.` } : { text: data.error ?? "No se pudo mandar el mail.", error: true });
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <h2 className="section-title">Contraseña</h2>
      <div className="day-card" style={{ maxWidth: 620 }}>
        <p className="field-hint" style={{ marginTop: 0 }}>
          Te mandamos a <strong>{email}</strong> un link para elegir una contraseña nueva. Vence en una hora.
        </p>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", flexWrap: "wrap" }}>
          <button className="btn btn-secondary" onClick={send} disabled={loading}>
            {loading ? "Enviando…" : "Cambiar contraseña"}
          </button>
          {message && (
            <span role="status" aria-live="polite" className={message.error ? "field-error" : "success-text"}>{message.text}</span>
          )}
        </div>
      </div>
    </>
  );
}
