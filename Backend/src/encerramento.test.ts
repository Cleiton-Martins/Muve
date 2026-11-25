import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEncerramento, PRAZO_DE_ENCERRAMENTO_MS } from "./encerramento.ts";
import { CHECKOUT_ORCAMENTO_MS } from "./services/paymentService.ts";

function pendente() {
  let resolver = () => {};
  let rejeitar = (_motivo: Error) => {};
  const promessa = new Promise<void>((resolve, reject) => {
    resolver = resolve;
    rejeitar = reject;
  });
  return { promessa, resolver: () => resolver(), rejeitar: (motivo: Error) => rejeitar(motivo) };
}

function cenario() {
  const servidor = pendente();
  const agenda = pendente();
  const fecharServidor = vi.fn(() => servidor.promessa);
  const pararAgenda = vi.fn(() => agenda.promessa);
  const sair = vi.fn();
  const log = vi.fn();
  const erro = vi.fn();
  const encerramento = createEncerramento({ fecharServidor, pararAgenda, sair, prazoMs: 1000, log, erro });
  return { servidor, agenda, fecharServidor, pararAgenda, sair, log, erro, encerramento };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("encerramento da API", () => {
  it("fecha o servidor, para a agenda e só sai com código 0 depois que os dois terminam", async () => {
    const c = cenario();

    const fim = c.encerramento.encerrar("SIGTERM");
    expect(c.fecharServidor).toHaveBeenCalledOnce();
    expect(c.pararAgenda).toHaveBeenCalledOnce();

    c.servidor.resolver();
    await vi.advanceTimersByTimeAsync(0);
    expect(c.sair).not.toHaveBeenCalled();

    c.agenda.resolver();
    await fim;
    expect(c.sair).toHaveBeenCalledExactlyOnceWith(0);
    expect(c.erro).not.toHaveBeenCalled();
    expect(c.log).toHaveBeenCalledWith(expect.stringContaining("SIGTERM"));
  });

  it("um segundo sinal não repete o fechamento nem a saída", async () => {
    const c = cenario();

    const primeiro = c.encerramento.encerrar("SIGTERM");
    const segundo = c.encerramento.encerrar("SIGINT");
    expect(segundo).toBe(primeiro);
    c.servidor.resolver();
    c.agenda.resolver();
    await primeiro;

    expect(c.fecharServidor).toHaveBeenCalledOnce();
    expect(c.pararAgenda).toHaveBeenCalledOnce();
    expect(c.sair).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("requisição que não termina no prazo força a saída com código 1, uma única vez", async () => {
    const c = cenario();

    const fim = c.encerramento.encerrar("SIGTERM");
    await vi.advanceTimersByTimeAsync(999);
    expect(c.sair).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(c.sair).toHaveBeenCalledExactlyOnceWith(1);
    expect(c.erro).toHaveBeenCalledWith(expect.stringContaining("saída forçada"));

    c.servidor.resolver();
    c.agenda.resolver();
    await fim;
    expect(c.sair).toHaveBeenCalledOnce();
  });

  it("falha ao fechar o servidor sai com código 1 sem registrar o conteúdo do erro", async () => {
    const c = cenario();

    const fim = c.encerramento.encerrar("SIGTERM");
    c.servidor.rejeitar(new Error("detalhe interno do servidor"));
    c.agenda.resolver();
    await fim;

    expect(c.sair).toHaveBeenCalledExactlyOnceWith(1);
    expect(JSON.stringify(c.erro.mock.calls)).not.toContain("detalhe interno");
  });

  it("depois de concluir, o prazo não dispara uma segunda saída", async () => {
    const c = cenario();

    const fim = c.encerramento.encerrar("SIGTERM");
    c.servidor.resolver();
    c.agenda.resolver();
    await fim;
    await vi.advanceTimersByTimeAsync(5000);

    expect(c.sair).toHaveBeenCalledExactlyOnceWith(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("o prazo padrão cobre o orçamento de um checkout em andamento", () => {
    expect(PRAZO_DE_ENCERRAMENTO_MS).toBeGreaterThan(CHECKOUT_ORCAMENTO_MS);
  });
});
