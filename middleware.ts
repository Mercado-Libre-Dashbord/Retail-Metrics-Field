import { NextResponse, type NextFetchEvent } from "next/server";
import { withAuth, type NextRequestWithAuth } from "next-auth/middleware";

const requireLogin = withAuth({
  pages: {
    signIn: "/login",
  },
});

export default function middleware(request: NextRequestWithAuth, event: NextFetchEvent) {
  // La app no usa next/image: el optimizador de imágenes de Next queda
  // apagado. Es la superficie de varias vulnerabilidades de Next 14 (RCE con
  // archivos AVIF, DoS, crecimiento del caché en disco) que recién se
  // corrigen en Next 15.5.
  if (request.nextUrl.pathname.startsWith("/_next/image")) {
    return new NextResponse(null, { status: 404 });
  }
  return requireLogin(request, event);
}

export const config = {
  // Sin login de la app (cada una se protege sola):
  // - api/auth, login, set-password: el propio login.
  // - api/ml: OAuth de Mercado Libre y su webhook.
  // - api/loyalty/members: la app de fidelización entra con su credencial
  //   (Bearer), no con sesión; la ruta valida la credencial o la sesión.
  matcher: ["/((?!api/auth|api/ml|api/set-password|api/loyalty/members|login|set-password|_next/static|favicon.ico).*)"],
};
