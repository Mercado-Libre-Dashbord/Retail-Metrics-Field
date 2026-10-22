import Script from "next/script";
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
      <body>
        <AuthProvider>
          <TaxConditionGate />
          <div className="app-shell">
            <NavBar />
            <main>{children}</main>
          </div>
        </AuthProvider>
        {/* Google Analytics 4 (etiqueta gtag). Se carga después de que la página
            es interactiva para no demorar la carga. */}
        {GA_MEASUREMENT_ID && (
          <>
            <Script src={`https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`} strategy="afterInteractive" />
            <Script id="ga4" strategy="afterInteractive">
              {`window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
gtag('config', '${GA_MEASUREMENT_ID}');`}
            </Script>
          </>
        )}
      </body>
    </html>
  );
}
