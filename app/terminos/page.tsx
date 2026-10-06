import type { Metadata } from "next";
import { CONTACT_EMAIL, PRODUCT_NAME } from "@/lib/site";
import { TRIAL_DAYS } from "@/lib/trial-request";

export const metadata: Metadata = { title: `Términos de uso · ${PRODUCT_NAME}` };

export default function TermsPage() {
  return (
    <article className="lp-doc">
      <a href="/" className="lp-doc-back">← Volver</a>
      <h1>Términos de uso</h1>
      <p className="lp-doc-date">Última actualización: octubre de 2026</p>

      <h2>El servicio</h2>
      <p>
        {PRODUCT_NAME} es una herramienta de MetricsField que se conecta a tu cuenta de Mercado Libre mediante su API
        oficial para calcular la rentabilidad de tus ventas, productos y publicidad. {PRODUCT_NAME} no está afiliado a
        Mercado Libre ni es un producto de Mercado Libre.
      </p>

      <h2>Prueba gratis</h2>
      <p>
        La prueba dura {TRIAL_DAYS} días, no requiere tarjeta y no genera ningún cargo. Al terminar te informamos las
        condiciones para seguir; si no seguís, la cuenta se desactiva.
      </p>

      <h2>Tu cuenta</h2>
      <ul>
        <li>Sos responsable de mantener seguro tu acceso y de la información que cargás (por ejemplo, tus costos).</li>
        <li>Autorizás a {PRODUCT_NAME} a leer los datos de tu cuenta de Mercado Libre necesarios para el servicio.</li>
        <li>
          Solo hacemos cambios en tu cuenta de Mercado Libre cuando los pedís desde el panel. Podés revocar el acceso en
          cualquier momento.
        </li>
      </ul>

      <h2>Alcance de los cálculos</h2>
      <p>
        Los resultados dependen de los datos que informa Mercado Libre y de los costos e impuestos que cargues. Son una
        herramienta de gestión y no reemplazan el asesoramiento contable o impositivo.
      </p>

      <h2>Uso aceptable</h2>
      <p>
        No podés usar el servicio para fines ilegales, intentar acceder a datos de otras cuentas ni afectar su
        funcionamiento.
      </p>

      <h2>Cambios</h2>
      <p>
        Podemos actualizar estos términos. Si el cambio es importante, te avisamos antes de que entre en vigencia.
      </p>

      <h2>Contacto</h2>
      <p>
        <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
      </p>
    </article>
  );
}
