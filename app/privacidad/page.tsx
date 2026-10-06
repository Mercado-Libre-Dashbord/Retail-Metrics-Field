import type { Metadata } from "next";
import { CONTACT_EMAIL, PRODUCT_NAME } from "@/lib/site";

export const metadata: Metadata = { title: `Política de privacidad · ${PRODUCT_NAME}` };

export default function PrivacyPage() {
  return (
    <article className="lp-doc">
      <a href="/" className="lp-doc-back">← Volver</a>
      <h1>Política de privacidad</h1>
      <p className="lp-doc-date">Última actualización: octubre de 2026</p>

      <p>
        {PRODUCT_NAME} es un servicio de MetricsField (&quot;nosotros&quot;) que calcula la rentabilidad de las ventas
        de una cuenta de Mercado Libre. Esta política explica qué datos tratamos, para qué y qué derechos tenés.
      </p>

      <h2>Qué datos tratamos</h2>
      <ul>
        <li>
          <strong>Datos de acceso:</strong> el email con el que entrás (Google o email y contraseña). Las contraseñas se
          guardan solo como un hash, nunca en texto.
        </li>
        <li>
          <strong>Datos de tu cuenta de Mercado Libre</strong>, que obtenemos con tu autorización mediante la API
          oficial: publicaciones, ventas, cargos (comisión, envío), métricas de publicidad, stock en Full y preguntas.
          Nunca vemos ni guardamos tu contraseña de Mercado Libre; usamos los permisos que vos otorgás y podés revocar.
        </li>
        <li>
          <strong>Datos que cargás vos:</strong> costos de productos, impuestos y configuración de la cuenta.
        </li>
        <li>
          <strong>Solicitudes de prueba:</strong> nombre, email, tienda, volumen de ventas, teléfono (opcional) y de qué
          campaña llegaste (parámetros utm), para contactarte y medir nuestras campañas.
        </li>
      </ul>

      <h2>Para qué los usamos</h2>
      <ul>
        <li>Mostrarte la rentabilidad de tus ventas, productos y publicidad.</li>
        <li>Hacer en tu cuenta de Mercado Libre solo los cambios que pidas desde el panel (por ejemplo, un precio).</li>
        <li>Contactarte por tu solicitud de prueba o por el servicio.</li>
      </ul>
      <p>No vendemos, alquilamos ni compartimos tus datos con terceros con fines comerciales.</p>

      <h2>Dónde se guardan</h2>
      <p>
        Usamos proveedores de infraestructura (alojamiento y base de datos) que pueden estar fuera de Argentina. Cada
        cuenta está aislada en la base de datos: ningún otro cliente puede ver tu información.
      </p>

      <h2>Cuánto tiempo</h2>
      <p>
        Mientras uses el servicio. Si dejás de usarlo o nos lo pedís, borramos tus datos, salvo lo que debamos
        conservar por obligación legal.
      </p>

      <h2>Tus derechos</h2>
      <p>
        Podés pedir acceso, rectificación, actualización o supresión de tus datos, y dejar de recibir comunicaciones,
        escribiendo a <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>. También podés revocar el acceso de la
        aplicación desde tu cuenta de Mercado Libre en cualquier momento.
      </p>
      <p>
        La Agencia de Acceso a la Información Pública, en su carácter de Órgano de Control de la Ley N° 25.326, tiene
        la atribución de atender las denuncias y reclamos que interpongan quienes resulten afectados en sus derechos
        por incumplimiento de las normas vigentes en materia de protección de datos personales.
      </p>

      <h2>Contacto</h2>
      <p>
        <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
      </p>
    </article>
  );
}
