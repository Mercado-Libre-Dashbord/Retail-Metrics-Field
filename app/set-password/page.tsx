"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import { MIN_PASSWORD_LENGTH } from "@/lib/credentials-constants";
import { PasswordInput } from "../PasswordInput";

function SetPasswordForm() {
  const params = useSearchParams();
  const token = params.get("token") ?? "";
  // Llegó por "Olvidé mi contraseña" (no por una invitación del admin).
  const isReset = params.get("reset") === "1";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`La contraseña tiene que tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`);
      return;
    }
    if (password !== confirm) {
      setError("Las dos contraseñas no coinciden.");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/set-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "No se pudo guardar la contraseña.");
        return;
      }
      setDone(true);
      // La contraseña recién quedó guardada; se usa la misma que se acaba
      // de tipear para entrar directo, sin pedirla de nuevo.
      const signInRes = await signIn("credentials", { email: data.email, password, redirect: false });
      if (!signInRes?.error) {
        window.location.href = "/";
      }
    } finally {
      setLoading(false);
    }
  }

  if (!token) {
    return (
      <div className="login-card">
        <h1 className="login-title">Link inválido</h1>
        <p className="login-subtitle">
          Este link no está completo. <a href="/forgot-password" className="login-link">Pedí uno nuevo</a>.
        </p>
      </div>
    );
  }

  return (
    <div className="login-card">
      <h1 className="login-title">{isReset ? "Elegí tu contraseña nueva" : "Elegí tu contraseña"}</h1>
      <p className="login-subtitle">Vas a usarla para entrar a partir de ahora, junto con tu email.</p>

      <form onSubmit={handleSubmit} noValidate style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)", width: "100%" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 4, textAlign: "left" }}>
          <label htmlFor="new-password" className="field-hint" style={{ margin: 0 }}>Contraseña nueva</label>
          <PasswordInput
            id="new-password"
            autoComplete="new-password"
            value={password}
            onChange={(v) => { setPassword(v); if (error) setError(""); }}
          />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4, textAlign: "left" }}>
          <label htmlFor="confirm-password" className="field-hint" style={{ margin: 0 }}>Repetila</label>
          <PasswordInput
            id="confirm-password"
            autoComplete="new-password"
            value={confirm}
            onChange={(v) => { setConfirm(v); if (error) setError(""); }}
          />
        </div>
        {error && (
          <p className="field-error" role="alert" style={{ textAlign: "left" }}>
            {error} {isReset && <a href="/forgot-password" className="login-link">Pedir un link nuevo</a>}
          </p>
        )}
        {done && !error && (
          <p className="success-text" role="status" style={{ textAlign: "left" }}>Contraseña guardada. Entrando…</p>
        )}
        <button type="submit" className="btn btn-primary" disabled={loading} aria-busy={loading || undefined}>
          {loading ? "Guardando…" : "Guardar y entrar"}
        </button>
      </form>
    </div>
  );
}

export default function SetPasswordPage() {
  return (
    <div className="login-shell">
      <Suspense fallback={null}>
        <SetPasswordForm />
      </Suspense>
    </div>
  );
}
