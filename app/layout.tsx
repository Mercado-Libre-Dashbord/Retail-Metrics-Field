import { Montserrat } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "./AuthProvider";
import { NavBar } from "./NavBar";
import { TaxConditionGate } from "./TaxConditionGate";
import { GA_MEASUREMENT_ID } from "@/lib/site";

const montserrat = Montserrat({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-montserrat",
  display: "swap",
});

export const metadata = { title: "Dashboard Rentabilidad ML" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" className={montserrat.variable}>
      <head>
        {/* Google Analytics 4. Va como etiqueta común en el <head> (y no con
            next/script) para que esté en el HTML que devuelve el servidor:
            así lo detecta el verificador de Google y se cuenta toda visita. */}
        {GA_MEASUREMENT_ID && (
          <>
            <script async src={`https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`} />
            <script
              dangerouslySetInnerHTML={{
                __html: `window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
gtag('config', '${GA_MEASUREMENT_ID}');`,
              }}
            />
          </>
        )}
      </head>
      <body>
        <AuthProvider>
          <TaxConditionGate />
          <div className="app-shell">
            <NavBar />
            <main>{children}</main>
          </div>
        </AuthProvider>
      </body>
    </html>
  );
}
