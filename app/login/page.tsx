"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { LOCKOUT_MINUTES } from "@/lib/credentials-constants";
import { PasswordInput } from "../PasswordInput";

const FEATURES = [
  "Tu cuenta de Mercado Libre, aislada y segura",
  "Rentabilidad real por producto, no estimada",
  "Sincronización con un click",
];

export default function LoginPage() {
  const [loading, setLoading] = useState(false);
  const [credEmail, setCredEmail] = useState("");
  const [credPassword, setCredPassword] = useState("");
  const [credLoading, setCredLoading] = useState(false);
  const [credError, setCredError] = useState("");

  function handleSignIn() {
    setLoading(true);
    signIn("google", { callbackUrl: "/" });
  }

  async function handleCredentialsSignIn(e: React.FormEvent) {
    e.preventDefault();
    setCredError("");
    if (!credEmail.trim() || !credPassword) {
      setCredError("Completá email y contraseña.");
      return;
    }
    setCredLoading(true);
    try {
      // redirect:false para poder mostrar el error acá mismo en vez de
      // depender del ?error= que NextAuth agrega a la URL de vuelta.
      const res = await signIn("credentials", {
        email: credEmail.trim().toLowerCase(),
        password: credPassword,
        redirect: false,
      });
      if (res?.error) {
        setCredError(
          `Email o contraseña incorrectos. Si fallaste varias veces seguidas, la cuenta queda bloqueada ` +
          `${LOCKOUT_MINUTES} minutos por seguridad.`
        );
        return;
      }
      window.location.href = "/";
    } finally {
      setCredLoading(false);
    }
  }

  return (
    <div className="login-shell">
      <div className="login-card">
        <div className="login-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" width="20" height="20">
            <path
              d="M4 17L9 8L13 14L16 9L20 17"
              stroke="#fff"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>

        <h1 className="login-title">Dashboard Rentabilidad ML</h1>
        <p className="login-subtitle">
          Entrá con tu cuenta de Google para ver la rentabilidad real de tu cuenta de Mercado Libre.
        </p>

        <button
          type="button"
          className="btn google-btn"
          onClick={handleSignIn}
          disabled={loading}
          aria-busy={loading || undefined}
        >
          {loading ? (
            <span className="google-btn-spinner" aria-hidden="true" />
          ) : (
            <svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true">
              <path
                fill="#EA4335"
                d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
              />
              <path
                fill="#4285F4"
                d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.9-2.26 5.36-4.78 7.02l7.73 6c4.51-4.18 7.09-10.36 7.09-17.49z"
              />
              <path
                fill="#FBBC05"
                d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24s.92 7.54 2.56 10.78l7.97-6.19z"
              />
              <path
                fill="#34A853"
                d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.97 6.19C6.51 42.62 14.62 48 24 48z"
              />
            </svg>
          )}
          <span>{loading ? "Conectando…" : "Continuar con Google"}</span>
        </button>

        <div className="login-divider"><span>o</span></div>

        <form onSubmit={handleCredentialsSignIn} noValidate style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)", width: "100%" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, textAlign: "left" }}>
            <label htmlFor="cred-email" className="field-hint" style={{ margin: 0 }}>Email</label>
            <input
              id="cred-email"
              type="email"
              autoComplete="email"
              value={credEmail}
              onChange={(e) => { setCredEmail(e.target.value); if (credError) setCredError(""); }}
            />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, textAlign: "left" }}>
            <label htmlFor="cred-password" className="field-hint" style={{ margin: 0 }}>Contraseña</label>
            <PasswordInput
              id="cred-password"
              autoComplete="current-password"
              value={credPassword}
              onChange={(v) => { setCredPassword(v); if (credError) setCredError(""); }}
            />
            <a href="/forgot-password" className="login-link">¿Olvidaste tu contraseña?</a>
          </div>
          {credError && <p className="field-error" role="alert" style={{ textAlign: "left" }}>{credError}</p>}
          <button type="submit" className="btn btn-secondary" disabled={credLoading} aria-busy={credLoading || undefined}>
            {credLoading ? "Entrando…" : "Entrar con email y contraseña"}
          </button>
        </form>

        <ul className="login-features">
          {FEATURES.map((feature) => (
            <li key={feature}>
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                <path
                  d="M3 8.5L6.2 11.7L13 4.5"
                  fill="none"
                  stroke="var(--positive)"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span>{feature}</span>
            </li>
          ))}
        </ul>
      </div>

      <p className="login-footnote">
        ¿Sos cliente y todavía no tenés cuenta? Pedile a tu administrador que te dé de alta, o que te mande el link
        para poner tu contraseña si no usás Google.
      </p>
    </div>
  );
}
