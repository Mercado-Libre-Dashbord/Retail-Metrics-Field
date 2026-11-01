"use client";

import { useState } from "react";

/** "Olvidé mi contraseña": pide el email y manda un link para elegir una nueva. */
export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!email.trim()) {
      setError("Escribí tu email.");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/password-reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "No se pudo mandar el mail.");
        return;
      }
      setSent(data.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-shell">
      <div className="login-card">
        <h1 className="login-title">Cambiar contraseña</h1>
        {sent ? (
          <>
            <p className="login-subtitle" role="status">{sent}</p>
            <a href="/login" className="btn btn-secondary" style={{ width: "100%", textDecoration: "none" }}>Volver a entrar</a>
          </>
        ) : (
          <>
            <p className="login-subtitle">
              Escribí el email con el que entrás y te mandamos un link para elegir una contraseña nueva.
            </p>
            <form onSubmit={handleSubmit} noValidate style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)", width: "100%" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 4, textAlign: "left" }}>
                <label htmlFor="reset-email" className="field-hint" style={{ margin: 0 }}>Email</label>
                <input
                  id="reset-email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => { setEmail(e.target.value); if (error) setError(""); }}
                />
              </div>
              {error && <p className="field-error" role="alert" style={{ textAlign: "left" }}>{error}</p>}
              <button type="submit" className="btn btn-primary" disabled={loading} aria-busy={loading || undefined}>
                {loading ? "Enviando…" : "Mandarme el link"}
              </button>
              <a href="/login" className="login-link" style={{ alignSelf: "center" }}>Volver a entrar</a>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
