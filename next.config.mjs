/**
 * Encabezados de seguridad para todas las respuestas:
 * - frame-ancestors / X-Frame-Options: nadie puede incrustar el panel en otra
 *   página (clickjacking: hacer que el vendedor "toque" botones sin verlos).
 * - nosniff: el navegador no adivina tipos de archivo (un CSV no se ejecuta
 *   como HTML).
 * - Referrer-Policy: no filtra rutas internas a sitios externos.
 * - Permissions-Policy: la app no usa cámara, micrófono ni ubicación.
 * - HSTS: siempre por HTTPS.
 */
const securityHeaders = [
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  // No se usa next/image (ver middleware.ts): optimizador apagado.
  images: { unoptimized: true },
  // No anunciar la tecnología del servidor.
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
