/**
 * Constantes del login con email y contraseña (ver migración 016),
 * separadas de lib/credentials-auth.ts porque ese módulo importa
 * `node:crypto` y no puede entrar en el bundle de un componente cliente
 * (ej. la página de login, que solo necesita estos números para mostrar
 * mensajes, no el hashing en sí).
 */
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_FAILED_ATTEMPTS = 5;
export const LOCKOUT_MINUTES = 15;
export const INVITE_EXPIRY_DAYS = 7;
/** Link de "olvidé mi contraseña": corto a propósito, llega por mail y se usa enseguida. */
export const RESET_EXPIRY_MINUTES = 60;
/** Pedidos de link por hora para un mismo email (evita usar la app para llenarle la casilla a alguien). */
export const MAX_RESETS_PER_HOUR = 3;
