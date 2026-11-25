import { createHash } from "node:crypto";
import { calcularComprovanteBase64Url } from "@muve/shared/pushComprovante.ts";
import { describe, expect, it, vi } from "vitest";
import { AppError } from "../domain/errors.ts";
import { createAccountService, type AccountService } from "../services/accountService.ts";
import type { EventService } from "../services/eventService.ts";
import type { VinculoDePushGateway } from "../services/notifications.ts";
import type { PaymentService } from "../services/paymentService.ts";
import { createApp } from "./app.ts";

const ORIGIN = "http://localhost:8443";
const TOKEN = "ExponentPushToken[ficticio-aparelho-1]";
const OPERACAO = "0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e";
const VINCULO = "33333333-3333-4333-8333-333333333333";
const SEGREDO = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const COMPROVANTE = calcularComprovanteBase64Url(TOKEN, OPERACAO, SEGREDO);
const bytesDoToken = Buffer.from(TOKEN, "utf8");
const comprovanteIndependente = createHash("sha256")
  .update(Buffer.concat([Buffer.from("newmuve-push-revogacao-v1", "utf8"), Buffer.from([0, bytesDoToken.length >> 8, bytesDoToken.length & 0xff]), bytesDoToken, Buffer.from(OPERACAO.replace(/-/g, ""), "hex"), Buffer.from(SEGREDO, "base64url")]))
  .digest("base64url");

function montar(devices: VinculoDePushGateway | null = gateway()) {
  const accounts = createAccountService({ devices: devices ?? undefined } as unknown as Parameters<typeof createAccountService>[0]);
  const app = createApp({
    accounts: accounts as AccountService,
    events: {} as EventService,
    payments: {} as PaymentService,
    asaasWebhookToken: "token-do-webhook",
    verifyToken: async (token) => (token === "token-valido" ? { id: "u1", email: "ana@exemplo.com" } : null),
    allowedOrigins: [ORIGIN],
  });
  const enviar = (caminho: string, corpo: unknown, autenticado = true) =>
    app.request(`/api${caminho}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(autenticado ? { Authorization: "Bearer token-valido" } : {}) },
      body: JSON.stringify(corpo),
    });
  return { enviar, devices };
}

function gateway(): VinculoDePushGateway {
  return {
    emitir: vi.fn(async () => ({ operationId: OPERACAO, vinculoId: VINCULO, estadoEsperado: "AUSENTE" as const, estado: "PENDENTE" as const, expiraEm: "2030-01-01T00:10:00Z", resultado: "EMITIDA" as const })),
    registrar: vi.fn(async () => ({ vinculoId: VINCULO, resultado: "REGISTRADO" as const })),
    cancelar: vi.fn(async () => ({ estado: "CANCELADA" as const, resultado: "CANCELADA" as const })),
    removerLegado: vi.fn(async () => ({ estado: null, resultado: "REMOVIDO" as const })),
    revogar: vi.fn(async () => ({ estado: "REVOGADA" as const, resultado: "REVOGADA" as const })),
  };
}

describe("rotas de dispositivos", () => {
  it("emissão exige sessão e repassa a operação ao banco pela conta da sessão", async () => {
    const { enviar, devices } = montar();

    const anonima = await enviar("/me/dispositivos/autorizacoes", { token: TOKEN, operationId: OPERACAO, comprovante: COMPROVANTE }, false);
    const resposta = await enviar("/me/dispositivos/autorizacoes", { token: TOKEN, operationId: OPERACAO, comprovante: COMPROVANTE, userId: "outra-conta" });

    expect(anonima.status).toBe(401);
    expect(resposta.status).toBe(201);
    expect(await resposta.json()).toMatchObject({ vinculoId: VINCULO, resultado: "EMITIDA" });
    expect(devices!.emitir).toHaveBeenCalledExactlyOnceWith("u1", { token: TOKEN, operationId: OPERACAO, comprovante: COMPROVANTE });
  });

  it.each([
    ["token fora do formato", { token: "abc", operationId: OPERACAO, comprovante: COMPROVANTE }],
    ["operação que não é UUID", { token: TOKEN, operationId: "1", comprovante: COMPROVANTE }],
    ["comprovante curto", { token: TOKEN, operationId: OPERACAO, comprovante: COMPROVANTE.slice(1) }],
    ["comprovante não canônico", { token: TOKEN, operationId: OPERACAO, comprovante: `${COMPROVANTE.slice(0, 42)}9` }],
    ["comprovante em base64 comum", { token: TOKEN, operationId: OPERACAO, comprovante: `${COMPROVANTE.slice(0, 42)}+` }],
  ])("emissão recusa %s antes de chegar ao banco", async (_caso, corpo) => {
    const { enviar, devices } = montar();

    expect((await enviar("/me/dispositivos/autorizacoes", corpo)).status).toBe(400);
    expect(devices!.emitir).not.toHaveBeenCalled();
  });

  it("registro manda a geração autorizada", async () => {
    const { enviar, devices } = montar();

    const resposta = await enviar("/me/dispositivos", { token: TOKEN, operationId: OPERACAO, comprovante: COMPROVANTE, vinculoId: VINCULO });

    expect(resposta.status).toBe(200);
    expect(await resposta.json()).toEqual({ vinculoId: VINCULO, resultado: "REGISTRADO" });
    expect(devices!.registrar).toHaveBeenCalledWith("u1", { token: TOKEN, operationId: OPERACAO, comprovante: COMPROVANTE, vinculoId: VINCULO });
  });

  it("registro no formato antigo (só token) é recusado em vez de gravar sem comprovante", async () => {
    const { enviar, devices } = montar();

    expect((await enviar("/me/dispositivos", { token: TOKEN })).status).toBe(400);
    expect(devices!.registrar).not.toHaveBeenCalled();
  });

  it("remoção com operação cancela; sem operação remove só o vínculo legado", async () => {
    const { enviar, devices } = montar();

    const cancelamento = await enviar("/me/dispositivos/remover", { token: TOKEN, operationId: OPERACAO, comprovante: COMPROVANTE });
    const legado = await enviar("/me/dispositivos/remover", { token: TOKEN });
    const incompleta = await enviar("/me/dispositivos/remover", { token: TOKEN, operationId: OPERACAO });

    expect(await cancelamento.json()).toEqual({ estado: "CANCELADA", resultado: "CANCELADA" });
    expect(await legado.json()).toEqual({ estado: null, resultado: "REMOVIDO" });
    expect(incompleta.status).toBe(400);
    expect(devices!.cancelar).toHaveBeenCalledWith("u1", { token: TOKEN, operationId: OPERACAO, comprovante: COMPROVANTE });
    expect(devices!.removerLegado).toHaveBeenCalledWith("u1", TOKEN);
  });

  it("revogação sem sessão: a API recalcula C pelo contrato compartilhado e nunca repassa o segredo", async () => {
    const { enviar, devices } = montar();

    const resposta = await enviar("/dispositivos/revogar", { token: TOKEN, operationId: OPERACAO, segredo: SEGREDO }, false);

    expect(resposta.status).toBe(200);
    expect(await resposta.json()).toEqual({ estado: "REVOGADA", resultado: "REVOGADA" });
    expect(devices!.revogar).toHaveBeenCalledExactlyOnceWith({ token: TOKEN, operationId: OPERACAO, comprovante: comprovanteIndependente });
    expect(JSON.stringify(vi.mocked(devices!.revogar).mock.calls)).not.toContain(SEGREDO);
  });

  it("revogação recusa segredo malformado", async () => {
    const { enviar, devices } = montar();

    for (const segredo of [SEGREDO.slice(1), `${SEGREDO}=`, `${SEGREDO.slice(0, 42)}9`]) {
      expect((await enviar("/dispositivos/revogar", { token: TOKEN, operationId: OPERACAO, segredo }, false)).status).toBe(400);
    }
    expect(devices!.revogar).not.toHaveBeenCalled();
  });

  it("sem o gateway configurado responde 503, nunca sucesso", async () => {
    const { enviar } = montar(null);

    const resposta = await enviar("/me/dispositivos/autorizacoes", { token: TOKEN, operationId: OPERACAO, comprovante: COMPROVANTE });

    expect(resposta.status).toBe(503);
    expect(await resposta.json()).toMatchObject({ error: { code: "PUSH_INDISPONIVEL" } });
  });

  it("erros do banco chegam ao app com o código", async () => {
    const devices = gateway();
    vi.mocked(devices.emitir).mockRejectedValueOnce(new AppError(409, "DISPOSITIVO_EM_OUTRA_CONTA", "Este aparelho ainda está vinculado às notificações de outra conta."));
    const { enviar } = montar(devices);

    const resposta = await enviar("/me/dispositivos/autorizacoes", { token: TOKEN, operationId: OPERACAO, comprovante: COMPROVANTE });

    expect(resposta.status).toBe(409);
    expect(await resposta.json()).toMatchObject({ error: { code: "DISPOSITIVO_EM_OUTRA_CONTA" } });
  });
});
