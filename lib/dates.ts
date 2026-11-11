/**
 * Zona horaria con la que se cortan los días y los meses en todo el panel.
 *
 * Mercado Libre muestra sus números en hora local del vendedor. La base y el
 * servidor corren en UTC: sin esto, una venta de las 21:30 de un martes caía
 * en el miércoles (y la del 31 a la noche, en el mes siguiente), así que el
 * día, la semana y el mes nunca coincidían con el panel de Mercado Libre.
 */
export const BUSINESS_TIME_ZONE = "America/Argentina/Buenos_Aires";

const formatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: BUSINESS_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
});

/** Día calendario (YYYY-MM-DD) de un instante, en la zona horaria del negocio. */
export function businessDateStr(value: Date | string): string {
  return formatter.format(value instanceof Date ? value : new Date(value));
}
