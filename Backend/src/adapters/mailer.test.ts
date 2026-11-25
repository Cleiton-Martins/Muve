import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMail = vi.hoisted(() => vi.fn());
vi.mock("nodemailer", () => ({ default: { createTransport: () => ({ sendMail }) } }));

import { createLogMailer, createSmtpMailer, falhaDeEnvioSemEnderecos } from "./mailer.ts";

const DESTINATARIO = "pessoa.destinataria@exemplo.test";
const REMETENTE = "remetente@exemplo.test";
const mensagem = { to: DESTINATARIO, subject: "Sua candidatura foi aprovada", text: "corpo" };
const smtp = () => createSmtpMailer({ host: "smtp.exemplo.test", port: 587, user: "usuario", pass: "segredo", from: REMETENTE });

function textoCompleto(error: unknown): string {
  const e = error as Error & { cause?: unknown };
  return [e.message, e.stack ?? "", JSON.stringify(e, Object.getOwnPropertyNames(e)), String(e.cause ?? "")].join("\n");
}

beforeEach(() => {
  sendMail.mockReset();
});

describe("envio por SMTP", () => {
  it("entrega a mensagem ao transporte com o remetente configurado", async () => {
    sendMail.mockResolvedValueOnce({});

    await smtp().send(mensagem);

    expect(sendMail).toHaveBeenCalledWith({ from: REMETENTE, ...mensagem });
  });

  it("a falha do transporte chega a quem chamou sem nenhum endereço de e-mail", async () => {
    const original = Object.assign(new Error(`Can't send mail - all recipients were rejected: 550 <${DESTINATARIO}> mailbox unavailable`), {
      code: "EENVELOPE",
      responseCode: 550,
      response: `550 <${DESTINATARIO}> mailbox unavailable`,
      rejected: [DESTINATARIO],
      command: `RCPT TO:<${DESTINATARIO}>`,
    });
    sendMail.mockRejectedValueOnce(original);

    const falha = await smtp()
      .send(mensagem)
      .catch((error: unknown) => error);

    expect(falha).toBeInstanceOf(Error);
    expect((falha as Error).message).toBe("Falha no envio de e-mail pelo SMTP (EENVELOPE, resposta 550)");
    const texto = textoCompleto(falha);
    expect(texto).not.toContain(DESTINATARIO);
    expect(texto).not.toContain(REMETENTE);
    expect(texto).not.toContain("@");
    expect(texto).not.toContain("segredo");
  });

  it("código de erro fora do formato esperado não é repassado", () => {
    expect(falhaDeEnvioSemEnderecos({ code: `falha para ${DESTINATARIO}`, responseCode: "550" }).message).toBe("Falha no envio de e-mail pelo SMTP");
    expect(falhaDeEnvioSemEnderecos("erro sem estrutura").message).toBe("Falha no envio de e-mail pelo SMTP");
    expect(falhaDeEnvioSemEnderecos(null).message).toBe("Falha no envio de e-mail pelo SMTP");
  });
});

describe("registro sem SMTP configurado", () => {
  it("registra que o e-mail não foi enviado, sem o endereço do destinatário", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await createLogMailer().send(mensagem);

    expect(log).toHaveBeenCalledOnce();
    const registrado = log.mock.calls[0]!.map(String).join(" ");
    expect(registrado).toContain("SMTP não configurado");
    expect(registrado).toContain(mensagem.subject);
    expect(registrado).not.toContain(DESTINATARIO);
    expect(registrado).not.toContain("@");
    log.mockRestore();
  });
});
