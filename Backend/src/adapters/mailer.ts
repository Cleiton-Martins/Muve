import nodemailer from "nodemailer";
import type { Mailer } from "../services/notifications.ts";

interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
}

const CODIGO_DE_ERRO = /^[A-Z][A-Z0-9_]{0,31}$/;

export function falhaDeEnvioSemEnderecos(error: unknown): Error {
  const origem = typeof error === "object" && error !== null ? (error as { code?: unknown; responseCode?: unknown }) : {};
  const detalhes: string[] = [];
  if (typeof origem.code === "string" && CODIGO_DE_ERRO.test(origem.code)) detalhes.push(origem.code);
  if (typeof origem.responseCode === "number" && Number.isInteger(origem.responseCode)) detalhes.push(`resposta ${origem.responseCode}`);
  return new Error(detalhes.length > 0 ? `Falha no envio de e-mail pelo SMTP (${detalhes.join(", ")})` : "Falha no envio de e-mail pelo SMTP");
}

export function createSmtpMailer(config: SmtpConfig): Mailer {
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.port === 465,
    auth: { user: config.user, pass: config.pass },
  });
  return {
    async send(message) {
      try {
        await transport.sendMail({ from: config.from, ...message });
      } catch (error) {
        throw falhaDeEnvioSemEnderecos(error);
      }
    },
  };
}

export function createLogMailer(): Mailer {
  return {
    async send(message) {
      console.log(`[e-mail não enviado: SMTP não configurado] ${message.subject}`);
    },
  };
}
