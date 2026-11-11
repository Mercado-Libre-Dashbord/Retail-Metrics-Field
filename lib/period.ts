export type Period = "hoy" | "semana" | "mes" | "trimestre" | "semestre" | "anio" | "historico" | "custom";

export const PERIOD_OPTIONS: { value: Period; label: string }[] = [
  { value: "hoy", label: "Hoy" },
  { value: "semana", label: "Esta semana" },
  { value: "mes", label: "Este mes" },
  { value: "trimestre", label: "Este trimestre" },
  { value: "semestre", label: "Este semestre" },
  { value: "anio", label: "Este año" },
  { value: "historico", label: "Histórico" },
  { value: "custom", label: "Rango personalizado" },
];

/**
 * Día calendario en la hora local de quien mira el panel. Con toISOString()
 * (UTC), después de las 21:00 de Argentina "hoy" ya era mañana y "esta
 * semana" arrancaba el martes.
 */
export function toDateStr(d: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function firstDayOfMonth(d: Date, month: number) {
  return new Date(d.getFullYear(), month, 1);
}

export function rangeForPeriod(period: Period, customFrom: string, customTo: string): { from: string; to: string } {
  const today = new Date();
  if (period === "hoy") {
    const d = toDateStr(today);
    return { from: d, to: d };
  }
  if (period === "semana") {
    // Semana calendario (lunes a domingo), no "últimos 7 días".
    const day = today.getDay();
    const diffToMonday = day === 0 ? -6 : 1 - day;
    const monday = new Date(today);
    monday.setDate(today.getDate() + diffToMonday);
    return { from: toDateStr(monday), to: toDateStr(today) };
  }
  if (period === "mes") {
    return { from: toDateStr(firstDayOfMonth(today, today.getMonth())), to: toDateStr(today) };
  }
  if (period === "trimestre") {
    const quarterStartMonth = Math.floor(today.getMonth() / 3) * 3;
    return { from: toDateStr(firstDayOfMonth(today, quarterStartMonth)), to: toDateStr(today) };
  }
  if (period === "semestre") {
    const semesterStartMonth = today.getMonth() < 6 ? 0 : 6;
    return { from: toDateStr(firstDayOfMonth(today, semesterStartMonth)), to: toDateStr(today) };
  }
  if (period === "anio") {
    return { from: toDateStr(firstDayOfMonth(today, 0)), to: toDateStr(today) };
  }
  if (period === "historico") {
    return { from: "1970-01-01", to: toDateStr(today) };
  }
  return { from: customFrom, to: customTo };
}
