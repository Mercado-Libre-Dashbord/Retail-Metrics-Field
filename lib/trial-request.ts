/**
 * Validación del formulario público "Pedí tu prueba" de la landing. Vive
 * aparte de la ruta para poder probarla sin HTTP: es la única puerta de
 * entrada a la base que no exige sesión, así que todo lo que llega se
 * recorta, se limita de largo y se rechaza si no tiene forma de dato real.
 */

export const TRIAL_DAYS = 14;

export const MONTHLY_SALES_OPTIONS = ["Menos de 50", "50 a 200", "200 a 1.000", "Más de 1.000"] as const;

export const TRIAL_STATUSES = ["nueva", "contactada", "activada", "descartada"] as const;
export type TrialStatus = (typeof TRIAL_STATUSES)[number];

export interface TrialRequestInput {
  name: string;
  email: string;
  store: string;
  monthlySales: string | null;
  phone: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmContent: string | null;
  referrer: string | null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed ? trimmed.slice(0, max) : null;
}

export type ParseResult = { ok: true; data: TrialRequestInput } | { ok: false; error: string } | { ok: "bot" };

export function parseTrialRequest(body: unknown): ParseResult {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  // Campo trampa: invisible para una persona, los bots lo completan.
  if (typeof b.website === "string" && b.website.trim() !== "") return { ok: "bot" };

  const name = text(b.name, 120);
  const email = text(b.email, 200)?.toLowerCase() ?? null;
  const store = text(b.store, 120);
  if (!name) return { ok: false, error: "Contanos tu nombre." };
  if (!email || !EMAIL_RE.test(email)) return { ok: false, error: "Revisá el email: no parece válido." };
  if (!store) return { ok: false, error: "Contanos el nombre de tu tienda en Mercado Libre." };

  const monthlySales = text(b.monthlySales, 40);
  const phone = text(b.phone, 40);
  return {
    ok: true,
    data: {
      name,
      email,
      store,
      monthlySales: monthlySales && (MONTHLY_SALES_OPTIONS as readonly string[]).includes(monthlySales) ? monthlySales : null,
      phone: phone && /^[0-9+()\-\s]{6,}$/.test(phone) ? phone : null,
      utmSource: text(b.utmSource, 100),
      utmMedium: text(b.utmMedium, 100),
      utmCampaign: text(b.utmCampaign, 100),
      utmContent: text(b.utmContent, 100),
      referrer: text(b.referrer, 300),
    },
  };
}
