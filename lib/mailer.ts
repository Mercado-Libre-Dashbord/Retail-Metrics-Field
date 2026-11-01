import nodemailer from "nodemailer";

/**
 * Envío de mails por SMTP. Sirve cualquier proveedor con SMTP, incluidos los
 * gratuitos: Gmail con una "contraseña de aplicación", Brevo, Resend, etc.
 *
 * Variables: SMTP_HOST, SMTP_PORT (465 = SSL, 587 = STARTTLS), SMTP_USER,
 * SMTP_PASS y MAIL_FROM (opcional; por defecto, SMTP_USER).
 */
export function mailEnabled(): boolean {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export async function sendMail(mail: Mail): Promise<void> {
  const port = Number(process.env.SMTP_PORT || 465);
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  await transport.sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, ...mail });
}
