import { NextResponse, type NextFetchEvent } from "next/server";
import { withAuth, type NextRequestWithAuth } from "next-auth/middleware";
import { getToken } from "next-auth/jwt";

const requireLogin = withAuth({
  pages: {
    signIn: "/login",
  },
});

export default async function middleware(request: NextRequestWithAuth, event: NextFetchEvent) {
  const { pathname } = request.nextUrl;
  // La app no usa next/image: el optimizador de imágenes de Next queda
  // apagado. Fue la superficie de varias vulnerabilidades (RCE con archivos
  // AVIF, DoS, crecimiento del caché en disco).
  if (pathname.startsWith("/_next/image")) {
    return new NextResponse(null, { status: 404 });
  }
  // La raíz es la landing para quien no tiene sesión y el panel para quien
  // sí. Rewrite (no redirect): la URL queda en "/" con sus utm intactas.
  if (pathname === "/") {
    const token = await getToken({ req: request });
    if (token) return NextResponse.next();
    const url = request.nextUrl.clone();
    url.pathname = "/inicio";
    return NextResponse.rewrite(url);
  }
  return requireLogin(request, event);
}

export const config = {
  // Sin login de la app (cada una se protege sola):
  // - api/auth, login, set-password: el propio login.
  // - api/ml: OAuth de Mercado Libre y su webhook.
  // - api/loyalty/members: la app de fidelización entra con su credencial
  //   (Bearer), no con sesión; la ruta valida la credencial o la sesión.
  // - inicio, privacidad, terminos, api/trial-requests: la landing pública y
  //   su formulario (el GET/PATCH de solicitudes exige admin en la ruta).
  // - archivos estáticos de public/ (logo).
  matcher: [
    "/((?!api/auth|api/ml|api/set-password|api/loyalty/members|api/trial-requests|login|set-password|inicio|privacidad|terminos|_next/static|favicon.ico|.*\\.(?:png|svg|jpg|jpeg|webp|ico)$).*)",
  ],
};
