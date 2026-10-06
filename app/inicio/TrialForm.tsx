"use client";

import { useEffect, useState } from "react";
import { MONTHLY_SALES_OPTIONS, TRIAL_DAYS } from "@/lib/trial-request";

const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content"] as const;
const STORAGE_KEY = "retail_utm";

/** Lee las utm del link (o las guardadas si la persona navegó antes de
 * completar el formulario) para saber qué campaña y variante la trajo. */
function readAttribution(): Record<string, string> {
  const fromUrl: Record<string, string> = {};
  try {
    const params = new URLSearchParams(window.location.search);
    for (const k of UTM_KEYS) {
      const v = params.get(k);
      if (v) fromUrl[k] = v;
    }
    if (Object.keys(fromUrl).length > 0) {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(fromUrl));
      return fromUrl;
    }
    return JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "{}");
  } catch {
    return fromUrl;
  }
}

export function TrialForm() {
  const [form, setForm] = useState({ name: "", email: "", store: "", monthlySales: "", phone: "", website: "" });
  const [attribution, setAttribution] = useState<Record<string, string>>({});
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState("");

  useEffect(() => setAttribution(readAttribution()), []);

  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((p) => ({ ...p, [key]: e.target.value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!form.name.trim() || !form.email.trim() || !form.store.trim()) {
      setError("Completá nombre, email y tienda.");
      return;
    }
    setState("sending");
    try {
      const res = await fetch("/api/trial-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          utmSource: attribution.utm_source,
          utmMedium: attribution.utm_medium,
          utmCampaign: attribution.utm_campaign,
          utmContent: attribution.utm_content,
          referrer: document.referrer || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "No pudimos enviar tu solicitud. Probá de nuevo.");
        setState("idle");
        return;
      }
      setState("sent");
    } catch {
      setError("No pudimos enviar tu solicitud. Revisá tu conexión y probá de nuevo.");
      setState("idle");
    }
  }

  if (state === "sent") {
    return (
      <div className="lp-form lp-form-done" role="status">
        <h3>¡Listo, {form.name.split(" ")[0]}!</h3>
        <p>
          Recibimos tu solicitud. Te escribimos a <strong>{form.email}</strong> para activar tus {TRIAL_DAYS} días de
          prueba y ayudarte a conectar tu cuenta.
        </p>
      </div>
    );
  }

  return (
    <form className="lp-form" onSubmit={submit} noValidate>
      <div className="lp-field">
        <label htmlFor="tr-name">Nombre</label>
        <input id="tr-name" autoComplete="name" value={form.name} onChange={set("name")} required />
      </div>
      <div className="lp-field">
        <label htmlFor="tr-email">Email</label>
        <input id="tr-email" type="email" autoComplete="email" value={form.email} onChange={set("email")} required />
        <span className="lp-hint">Si entrás con Google, el de tu cuenta de Google.</span>
      </div>
      <div className="lp-field">
        <label htmlFor="tr-store">Tu tienda en Mercado Libre</label>
        <input id="tr-store" value={form.store} onChange={set("store")} placeholder="Nombre o nick de la tienda" required />
      </div>
      <div className="lp-field-row">
        <div className="lp-field">
          <label htmlFor="tr-sales">Ventas por mes</label>
          <select id="tr-sales" value={form.monthlySales} onChange={set("monthlySales")}>
            <option value="">Elegí</option>
            {MONTHLY_SALES_OPTIONS.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </div>
        <div className="lp-field">
          <label htmlFor="tr-phone">WhatsApp (opcional)</label>
          <input id="tr-phone" type="tel" autoComplete="tel" value={form.phone} onChange={set("phone")} />
        </div>
      </div>
      {/* Campo trampa para bots: oculto para personas y lectores de pantalla. */}
      <div className="lp-hp" aria-hidden="true">
        <label htmlFor="tr-website">Sitio web</label>
        <input id="tr-website" tabIndex={-1} autoComplete="off" value={form.website} onChange={set("website")} />
      </div>
      {error && (
        <p className="lp-error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className="btn btn-primary lp-submit" disabled={state === "sending"}>
        {state === "sending" ? "Enviando…" : `Pedir mis ${TRIAL_DAYS} días gratis`}
      </button>
      <p className="lp-legal">
        Sin tarjeta. Al enviar aceptás la <a href="/privacidad">política de privacidad</a>.
      </p>
    </form>
  );
}
