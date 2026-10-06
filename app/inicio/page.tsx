import type { Metadata } from "next";
import { TrialForm } from "./TrialForm";
import { CONTACT_EMAIL, DEMO_VIDEO_URL, PRODUCT_NAME } from "@/lib/site";
import { TRIAL_DAYS } from "@/lib/trial-request";

export const metadata: Metadata = {
  title: `${PRODUCT_NAME} · Cuánto te queda de verdad en cada venta de Mercado Libre`,
  description:
    "Ganancia real por venta, margen por producto y ROAS y ACOS reales de Mercado Ads. Conectás tu cuenta en un minuto y lo probás gratis 14 días.",
};

const fmt = (n: number) => `$${n.toLocaleString("es-AR")}`;

// Ejemplo ilustrativo (no es una venta real): suma exacta para que el
// desglose cierre a la vista.
const SALE = { revenue: 25000, commission: 3875, shipping: 4200, ads: 2100, cost: 11500, taxes: 1250 };
const SALE_PROFIT = SALE.revenue - SALE.commission - SALE.shipping - SALE.ads - SALE.cost - SALE.taxes;

const FEATURES = [
  {
    title: "Ganancia real por venta",
    body: "Cada venta, desarmada: precio − comisión − envío − publicidad − costo − impuestos. Ves en pesos cuánto te quedó, venta por venta.",
  },
  {
    title: "Margen por producto",
    body: "Cargás el costo una vez (en pesos o en dólares) y Retail recalcula todo. Detectás las publicaciones que venden mucho y no dejan nada.",
  },
  {
    title: "Publicidad con números reales",
    body: "ROAS y ACOS de cada anuncio de Mercado Ads con las ventas que el anuncio trajo de verdad, tu ACOS de equilibrio y qué conviene pausar, mantener o empujar.",
  },
];

const EXTRAS = [
  ["Tendencias", "Cómo evolucionan ventas y ganancia en el tiempo."],
  ["Full", "Stock en los depósitos de Mercado Libre y hace cuánto está."],
  ["Preguntas", "Las consultas de tus publicaciones en un solo lugar."],
  ["Impuestos", "IIBB y otros impuestos, e IVA según tu régimen fiscal."],
  ["Exportación", "Tus ventas con el desglose completo, a Excel o CSV."],
  ["Sincronización", "Un click y tus ventas nuevas quedan calculadas."],
];

const STEPS = [
  ["Conectás tu cuenta", "Con el acceso oficial de Mercado Libre. Nunca te pedimos tu contraseña."],
  ["Cargás tus costos", "Una vez por producto. Si cambian, los actualizás y se recalcula solo."],
  ["Ves tu ganancia real", "Por venta, por producto y por anuncio. Y decidís con números."],
];

const FAQ = [
  ["¿Necesito tarjeta para la prueba?", `No. Son ${TRIAL_DAYS} días gratis, sin tarjeta y sin compromiso.`],
  [
    "¿Qué pasa cuando terminan los 14 días?",
    "Te contamos los planes. Si no seguís, no se cobra nada y podés pedirnos que borremos tus datos.",
  ],
  [
    "¿Retail es de Mercado Libre?",
    "No. Retail es un producto de MetricsField que se conecta a tu cuenta mediante la API oficial de Mercado Libre.",
  ],
  [
    "¿Pueden tocar mis publicaciones?",
    "Solo hacemos cambios cuando vos los pedís desde el panel (por ejemplo, actualizar un precio o pausar una campaña). Podés desconectar la cuenta cuando quieras.",
  ],
  ["¿Funciona con Full y con Mercado Ads?", "Sí. El envío, la publicidad y el stock en Full entran en el cálculo."],
  [
    "¿Qué pasa con mis datos?",
    "Cada cuenta queda aislada en la base de datos: nadie más ve tus números. No vendemos ni compartimos tu información.",
  ],
];

export default function LandingPage() {
  return (
    <div className="lp">
      <header className="lp-top">
        <a href="/" className="lp-brand" aria-label="MetricsField">
          <span className="lp-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" width="16" height="16">
              <path d="M4 17L9 8L13 14L16 9L20 17" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <span>
            {PRODUCT_NAME} <small>by MetricsField</small>
          </span>
        </a>
        <nav className="lp-top-actions">
          <a href="/login" className="lp-link">
            Entrar
          </a>
          <a href="#prueba" className="btn btn-primary btn-sm">
            Probar gratis
          </a>
        </nav>
      </header>

      <section className="lp-hero">
        <div className="lp-hero-copy">
          <p className="lp-eyebrow">Para vendedores de Mercado Libre</p>
          <h1>Facturar no es ganar.</h1>
          <p className="lp-lead">
            Retail te muestra cuánto te queda de verdad en cada venta: después de la comisión, el envío, la
            publicidad, el costo y los impuestos.
          </p>
          <div className="lp-cta-row">
            <a href="#prueba" className="btn btn-primary lp-cta">
              Probalo gratis {TRIAL_DAYS} días
            </a>
            <a href="#como-funciona" className="btn btn-secondary lp-cta">
              Cómo funciona
            </a>
          </div>
          <p className="lp-micro">Sin tarjeta · Conectás tu cuenta en un minuto</p>
        </div>

        <div className="lp-hero-visual">
          {DEMO_VIDEO_URL ? (
            <div className="lp-video">
              <iframe
                src={DEMO_VIDEO_URL}
                title={`${PRODUCT_NAME} en 2 minutos`}
                allow="autoplay; fullscreen; picture-in-picture"
                allowFullScreen
              />
            </div>
          ) : (
            <figure className="lp-sale" aria-label="Ejemplo de desglose de una venta">
              <figcaption>
                <span>Una venta, desarmada</span>
                <span className="lp-tag">Ejemplo ilustrativo</span>
              </figcaption>
              <div className="lp-sale-row lp-sale-head">
                <span>Precio de venta</span>
                <strong>{fmt(SALE.revenue)}</strong>
              </div>
              {(
                [
                  ["Comisión de Mercado Libre", SALE.commission],
                  ["Envío", SALE.shipping],
                  ["Publicidad", SALE.ads],
                  ["Costo del producto", SALE.cost],
                  ["Impuestos", SALE.taxes],
                ] as const
              ).map(([label, value]) => (
                <div key={label} className="lp-sale-row">
                  <span>{label}</span>
                  <span className="lp-neg">−{fmt(value)}</span>
                </div>
              ))}
              <div className="lp-sale-row lp-sale-total">
                <span>Te quedó</span>
                <strong>
                  {fmt(SALE_PROFIT)} <small>({((SALE_PROFIT / SALE.revenue) * 100).toFixed(1).replace(".", ",")}%)</small>
                </strong>
              </div>
              <p className="lp-sale-note">El panel de ventas te muestra {fmt(SALE.revenue)}. Retail te muestra esto.</p>
            </figure>
          )}
        </div>
      </section>

      <section className="lp-band">
        <p>
          El panel de Mercado Libre te dice cuánto vendiste. <strong>No te dice cuánto ganaste</strong>, ni qué
          publicaciones pierden plata cada vez que venden, ni si tu publicidad se paga sola.
        </p>
      </section>

      <section className="lp-section">
        <h2>Lo que vas a ver desde el primer día</h2>
        <div className="lp-grid-3">
          {FEATURES.map((f) => (
            <article key={f.title} className="lp-card">
              <h3>{f.title}</h3>
              <p>{f.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="lp-section lp-ads">
        <div>
          <p className="lp-eyebrow">Mercado Ads</p>
          <h2>Tu ROAS puede estar mintiendo.</h2>
          <p>
            Si dividís toda tu facturación por lo que gastaste en publicidad, el número sale lindo. Pero mezcla las
            ventas que habrías hecho igual. Retail usa solo las ventas que trajo cada anuncio y las compara con tu
            margen: así sabés cuánto podés gastar sin perder plata.
          </p>
        </div>
        <figure className="lp-ads-card" aria-label="Ejemplo de métricas de publicidad">
          <figcaption>
            <span>Un anuncio</span>
            <span className="lp-tag">Ejemplo ilustrativo</span>
          </figcaption>
          <dl>
            <div>
              <dt>ROAS "general"</dt>
              <dd className="lp-muted">8,0x</dd>
            </div>
            <div>
              <dt>ROAS real del anuncio</dt>
              <dd>3,2x</dd>
            </div>
            <div>
              <dt>ACOS real</dt>
              <dd>31%</dd>
            </div>
            <div>
              <dt>ACOS de equilibrio</dt>
              <dd>24%</dd>
            </div>
          </dl>
          <p className="lp-verdict">Recomendación: pausar. Este anuncio vende, pero a pérdida.</p>
        </figure>
      </section>

      <section className="lp-section" id="como-funciona">
        <h2>Cómo funciona</h2>
        <ol className="lp-steps">
          {STEPS.map(([title, body], i) => (
            <li key={title}>
              <span className="lp-step-n">{i + 1}</span>
              <h3>{title}</h3>
              <p>{body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="lp-section">
        <h2>Y además</h2>
        <div className="lp-grid-extras">
          {EXTRAS.map(([title, body]) => (
            <div key={title} className="lp-extra">
              <strong>{title}</strong>
              <span>{body}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="lp-section lp-trust">
        <h2>Tus números son tuyos</h2>
        <ul>
          <li>Conexión con el acceso oficial de Mercado Libre: nunca vemos ni guardamos tu contraseña.</li>
          <li>Cada cuenta está aislada en la base de datos. Nadie más ve tus ventas ni tus costos.</li>
          <li>No vendemos ni compartimos tu información. Podés desconectarte y pedir el borrado cuando quieras.</li>
        </ul>
      </section>

      <section className="lp-section lp-signup" id="prueba">
        <div className="lp-signup-copy">
          <h2>Probalo {TRIAL_DAYS} días con tus propios números</h2>
          <p>
            Dejanos tus datos y te activamos la prueba. Te ayudamos a conectar la cuenta y cargar los primeros costos
            para que veas tus números reales desde el primer día.
          </p>
          <ul className="lp-checks">
            <li>Sin tarjeta</li>
            <li>Acompañamiento para arrancar</li>
            <li>Si no te sirve, no pasa nada</li>
          </ul>
        </div>
        <TrialForm />
      </section>

      <section className="lp-section">
        <h2>Preguntas frecuentes</h2>
        <div className="lp-faq">
          {FAQ.map(([q, a]) => (
            <details key={q}>
              <summary>{q}</summary>
              <p>{a}</p>
            </details>
          ))}
        </div>
      </section>

      <footer className="lp-footer">
        <span>© {new Date().getFullYear()} MetricsField</span>
        <nav>
          <a href="/privacidad">Privacidad</a>
          <a href="/terminos">Términos</a>
          <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
        </nav>
        <p>Retail no está afiliado a Mercado Libre ni es un producto de Mercado Libre.</p>
      </footer>
    </div>
  );
}
