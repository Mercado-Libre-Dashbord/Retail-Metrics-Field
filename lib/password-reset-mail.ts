import { RESET_EXPIRY_MINUTES } from "./credentials-constants";
import type { Mail } from "./mailer";

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** El mail con el link para elegir una contraseña nueva. */
export function passwordResetMail(to: string, link: string): Mail {
  const subject = "Cambiá tu contraseña de Retail by MetricsField";
  const text = [
    "Hola,",
    "",
    "Pediste cambiar la contraseña con la que entrás a Retail by MetricsField. Para elegir una nueva, abrí este link:",
    link,
    "",
    `El link vence en ${RESET_EXPIRY_MINUTES} minutos y sirve una sola vez.`,
    "Si no lo pediste vos, ignorá este mail: tu contraseña no cambia.",
  ].join("\n");
  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#1d2733;max-width:520px">
  <p>Hola,</p>
  <p>Pediste cambiar la contraseña con la que entrás a <strong>Retail by MetricsField</strong>. Para elegir una nueva, tocá el botón:</p>
  <p style="margin:24px 0"><a href="${escape(link)}" style="background:#1f4e80;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:bold;display:inline-block">Elegir contraseña nueva</a></p>
  <p style="font-size:13px;color:#5b6675">Si el botón no anda, copiá este link en el navegador:<br><a href="${escape(link)}" style="color:#1f4e80;word-break:break-all">${escape(link)}</a></p>
  <p style="font-size:13px;color:#5b6675">El link vence en ${RESET_EXPIRY_MINUTES} minutos y sirve una sola vez. Si no lo pediste vos, ignorá este mail: tu contraseña no cambia.</p>
</div>`;
  return { to, subject, text, html };
}
