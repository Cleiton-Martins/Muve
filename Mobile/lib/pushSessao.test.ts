import { randomBytes, randomUUID } from "node:crypto";
import { calcularComprovanteBase64Url } from "@muve/shared/pushComprovante.ts";
import { describe, expect, it, vi } from "vitest";
import { criarArmazenamentoDePush, type ArmazenamentoSeguro } from "./pushArmazenamento";
import { criarVinculoDePush, DISPOSITIVO_EM_OUTRA_CONTA, sairDaConta, type ApiDePush } from "./pushSessao";

const TOKEN = "ExponentPushToken[ficticio-aparelho-1]";
const TOKEN_NOVO = "ExponentPushToken[ficticio-aparelho-2]";

class RecusaDaApi extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

type Metodo = keyof ApiDePush;

interface Autorizacao {
  userId: string;
  token: string;
  comprovante: string;
  vinculoId: string;
  esperado: string | null;
  estado: "PENDENTE" | "REGISTRADA" | "CANCELADA" | "REVOGADA";
}

function servidorSimulado() {
  const autorizacoes = new Map<string, Autorizacao>();
  const vinculos = new Map<string, { userId: string; operationId: string | null; vinculoId: string }>();
  let geracoes = 0;
  const estado = {
    conta: "ana" as string | null,
    sessaoValida: true,
    foraDoAr: false,
    perderRespostaDe: null as Metodo | null,
    chamadas: [] as string[],
  };
  const novaGeracao = () => `00000000-0000-4000-8000-${String(++geracoes).padStart(12, "0")}`;
  const terminal = (a: Autorizacao) => a.estado === "CANCELADA" || a.estado === "REVOGADA";

  function entrar(metodo: Metodo, comSessao = true): string {
    estado.chamadas.push(`${metodo}:${comSessao ? estado.conta : "sem-sessao"}`);
    if (estado.foraDoAr) throw new RecusaDaApi(0, "SEM_CONEXAO");
    if (!comSessao) return "";
    if (!estado.conta || !estado.sessaoValida) throw new RecusaDaApi(401, "NAO_AUTENTICADO");
    return estado.conta;
  }
  function responder<T>(metodo: Metodo, resposta: T): T {
    if (estado.perderRespostaDe === metodo) {
      estado.perderRespostaDe = null;
      throw new RecusaDaApi(0, "SEM_CONEXAO");
    }
    return resposta;
  }
  function removerVinculoDa(operationId: string, a: Autorizacao) {
    const vinculo = vinculos.get(a.token);
    if (a.estado === "REGISTRADA" && vinculo?.operationId === operationId && vinculo.vinculoId === a.vinculoId) vinculos.delete(a.token);
  }

  const api: ApiDePush = {
    emitir: vi.fn(async ({ token, operationId, comprovante }) => {
      const userId = entrar("emitir");
      const existente = autorizacoes.get(operationId);
      if (existente) {
        if (existente.userId !== userId || existente.comprovante !== comprovante) throw new RecusaDaApi(409, "PUSH_OPERACAO_CONFLITANTE");
        return responder("emitir", {
          operationId,
          vinculoId: existente.vinculoId,
          estadoEsperado: "AUSENTE" as const,
          estado: existente.estado,
          expiraEm: "",
          resultado: terminal(existente) ? ("TERMINAL" as const) : ("JA_EMITIDA" as const),
        });
      }
      const vinculo = vinculos.get(token);
      if (vinculo && vinculo.userId !== userId) throw new RecusaDaApi(409, DISPOSITIVO_EM_OUTRA_CONTA);
      const nova: Autorizacao = { userId, token, comprovante, vinculoId: novaGeracao(), esperado: vinculo?.vinculoId ?? null, estado: "PENDENTE" };
      autorizacoes.set(operationId, nova);
      return responder("emitir", {
        operationId,
        vinculoId: nova.vinculoId,
        estadoEsperado: vinculo ? ("VINCULADO" as const) : ("AUSENTE" as const),
        estado: "PENDENTE" as const,
        expiraEm: "",
        resultado: "EMITIDA" as const,
      });
    }),
    registrar: vi.fn(async ({ token, operationId, comprovante, vinculoId }) => {
      const userId = entrar("registrar");
      const a = autorizacoes.get(operationId);
      if (!a) throw new RecusaDaApi(409, "PUSH_AUTORIZACAO_INEXISTENTE");
      if (a.userId !== userId || a.token !== token || a.comprovante !== comprovante || a.vinculoId !== vinculoId) throw new RecusaDaApi(409, "PUSH_AUTORIZACAO_NAO_CONFERE");
      if (a.estado === "REGISTRADA") {
        if (vinculos.get(token)?.vinculoId === a.vinculoId) return responder("registrar", { vinculoId, resultado: "JA_REGISTRADO" as const });
        throw new RecusaDaApi(409, "PUSH_GERACAO_SUBSTITUIDA");
      }
      if (a.estado !== "PENDENTE") throw new RecusaDaApi(409, "PUSH_AUTORIZACAO_TERMINAL");
      if ((vinculos.get(token)?.vinculoId ?? null) !== a.esperado) throw new RecusaDaApi(409, "PUSH_ESTADO_ALTERADO");
      vinculos.set(token, { userId, operationId, vinculoId: a.vinculoId });
      a.estado = "REGISTRADA";
      return responder("registrar", { vinculoId, resultado: "REGISTRADO" as const });
    }),
    cancelar: vi.fn(async ({ token, operationId, comprovante }) => {
      const userId = entrar("cancelar");
      const a = autorizacoes.get(operationId);
      if (!a) {
        autorizacoes.set(operationId, { userId, token, comprovante, vinculoId: novaGeracao(), esperado: null, estado: "CANCELADA" });
        return responder("cancelar", { estado: "CANCELADA" as const, resultado: "CANCELADA_SEM_EMISSAO" as const });
      }
      if (a.userId !== userId || a.token !== token || a.comprovante !== comprovante) throw new RecusaDaApi(409, "PUSH_AUTORIZACAO_NAO_CONFERE");
      if (terminal(a)) return responder("cancelar", { estado: a.estado, resultado: "JA_ENCERRADA" as const });
      removerVinculoDa(operationId, a);
      a.estado = "CANCELADA";
      return responder("cancelar", { estado: "CANCELADA" as const, resultado: "CANCELADA" as const });
    }),
    revogar: vi.fn(async ({ token, operationId, segredo }) => {
      entrar("revogar", false);
      const a = autorizacoes.get(operationId);
      if (!a) return responder("revogar", { estado: null, resultado: "DESCONHECIDA" as const });
      if (a.token !== token || a.comprovante !== calcularComprovanteBase64Url(token, operationId, segredo)) return responder("revogar", { estado: null, resultado: "NEGADA" as const });
      if (terminal(a)) return responder("revogar", { estado: a.estado, resultado: "JA_ENCERRADA" as const });
      removerVinculoDa(operationId, a);
      a.estado = "REVOGADA";
      return responder("revogar", { estado: "REVOGADA" as const, resultado: "REVOGADA" as const });
    }),
  };
  return { api, estado, autorizacoes, vinculos };
}

function memoria(): ArmazenamentoSeguro & { dados: Map<string, string>; falharGravacao: boolean } {
  const dados = new Map<string, string>();
  const m = {
    dados,
    falharGravacao: false,
    disponivel: async () => true,
    ler: async (chave: string) => dados.get(chave) ?? null,
    gravar: async (chave: string, valor: string) => {
      if (m.falharGravacao) throw new Error("disco cheio");
      dados.set(chave, valor);
    },
    apagar: async (chave: string) => {
      if (m.falharGravacao) throw new Error("disco cheio");
      dados.delete(chave);
    },
  };
  return m;
}

function aparelho(servidor = servidorSimulado(), disco = memoria()) {
  const armazenamento = criarArmazenamentoDePush({ seguro: disco });
  const aleatorio: { disponivel: boolean; operacao?: string; segredo?: Uint8Array } = { disponivel: true };
  const vinculo = criarVinculoDePush({
    api: servidor.api,
    armazenamento,
    contaAtual: async () => (servidor.estado.sessaoValida ? servidor.estado.conta : null),
    gerarOperacao: () => {
      if (!aleatorio.disponivel) throw new Error("sem gerador seguro");
      return aleatorio.operacao ?? randomUUID();
    },
    gerarSegredo: async () => {
      if (!aleatorio.disponivel) throw new Error("sem gerador seguro");
      return aleatorio.segredo ?? new Uint8Array(randomBytes(32));
    },
  });
  const sessao = { aberta: true };
  const encerrarSessao = vi.fn(async () => {
    sessao.aberta = false;
    servidor.estado.conta = null;
  });
  const sair = () => sairDaConta({ desvincular: () => vinculo.desvincular(), encerrarSessao });
  return { vinculo, servidor, disco, aleatorio, sessao, sair, obter: async () => TOKEN };
}

const dono = (a: ReturnType<typeof aparelho>, token = TOKEN) => a.servidor.vinculos.get(token)?.userId ?? null;

describe("registro com autorização persistida", () => {
  it("cria a operação local antes de chamar o servidor e só a marca registrada depois da confirmação", async () => {
    const a = aparelho();

    expect(await a.vinculo.vincular(a.obter)).toBe("REGISTRADO");

    expect(a.servidor.estado.chamadas).toEqual(["emitir:ana", "registrar:ana"]);
    expect(dono(a)).toBe("ana");
    const [local] = await a.vinculo.pendentes();
    expect(local).toMatchObject({ userId: "ana", token: TOKEN, fase: "REGISTRADA" });
    expect(a.servidor.vinculos.get(TOKEN)?.operationId).toBe(local.operationId);
  });

  it("repetir o vínculo reaproveita a operação registrada sem emitir de novo", async () => {
    const a = aparelho();
    await a.vinculo.vincular(a.obter);

    expect(await a.vinculo.vincular(a.obter)).toBe("REGISTRADO");

    expect(a.servidor.estado.chamadas).toEqual(["emitir:ana", "registrar:ana", "registrar:ana"]);
    expect(a.servidor.autorizacoes.size).toBe(1);
  });

  it("resposta da emissão perdida: guarda a operação e retoma com o mesmo operation_id", async () => {
    const a = aparelho();
    a.servidor.estado.perderRespostaDe = "emitir";

    expect(await a.vinculo.vincular(a.obter)).toBe("FALHOU");
    const [pendente] = await a.vinculo.pendentes();
    expect(pendente.fase).toBe("EMITINDO");
    expect(dono(a)).toBeNull();

    expect(await a.vinculo.vincular(a.obter)).toBe("REGISTRADO");
    expect([...a.servidor.autorizacoes.keys()]).toEqual([pendente.operationId]);
  });

  it("resposta do registro perdida: não declara sucesso e conclui na próxima tentativa", async () => {
    const a = aparelho();
    a.servidor.estado.perderRespostaDe = "registrar";

    expect(await a.vinculo.vincular(a.obter)).toBe("FALHOU");
    expect((await a.vinculo.pendentes())[0].fase).toBe("EMITIDA");

    expect(await a.vinculo.vincular(a.obter)).toBe("REGISTRADO");
    expect(a.servidor.autorizacoes.size).toBe(1);
    expect((await a.vinculo.pendentes())[0].fase).toBe("REGISTRADA");
  });

  it("sem conexão: nada é apagado e nada é declarado registrado", async () => {
    const a = aparelho();
    a.servidor.estado.foraDoAr = true;

    expect(await a.vinculo.vincular(a.obter)).toBe("FALHOU");
    expect(await a.vinculo.pendentes()).toHaveLength(1);
  });

  it("falha ao gravar a operação local: não chama o servidor", async () => {
    const a = aparelho();
    a.disco.falharGravacao = true;

    expect(await a.vinculo.vincular(a.obter)).toBe("INDISPONIVEL");
    expect(a.servidor.estado.chamadas).toEqual([]);
  });

  it("sem gerador aleatório seguro: não registra e não usa substituto inseguro", async () => {
    const a = aparelho();
    a.aleatorio.disponivel = false;

    expect(await a.vinculo.vincular(a.obter)).toBe("INDISPONIVEL");
    expect(a.servidor.estado.chamadas).toEqual([]);
    expect(await a.vinculo.pendentes()).toEqual([]);
  });

  it.each([
    ["UUID fora do padrão v4", { operacao: "not-a-uuid" }],
    ["UUID de outra versão", { operacao: "0f1e2d3c-4b5a-1968-8778-695a4b3c2d1e" }],
    ["segredo curto", { segredo: new Uint8Array(31) }],
  ])("geração insegura (%s): não grava nem chama o servidor", async (_caso, gerado) => {
    const a = aparelho();
    Object.assign(a.aleatorio, gerado);

    expect(await a.vinculo.vincular(a.obter)).toBe("INDISPONIVEL");
    expect(a.servidor.estado.chamadas).toEqual([]);
    expect(await a.vinculo.pendentes()).toEqual([]);
  });

  it("guarda a intenção determinada pelo servidor depois da emissão", async () => {
    const a = aparelho();
    a.servidor.estado.perderRespostaDe = "registrar";
    await a.vinculo.vincular(a.obter);

    expect((await a.vinculo.pendentes())[0]).toMatchObject({ fase: "EMITIDA", intencao: "CREATE" });
  });

  it("registro abandonado porque a sessão acabou não grava nada nem chama o servidor", async () => {
    const a = aparelho();

    expect(await a.vinculo.vincular(a.obter, () => false)).toBe("INATIVO");
    expect(a.servidor.estado.chamadas).toEqual([]);
    expect(await a.vinculo.pendentes()).toEqual([]);
  });

  it("sem token, nada acontece", async () => {
    const a = aparelho();

    expect(await a.vinculo.vincular(async () => null)).toBe("SEM_TOKEN");
    expect(a.servidor.estado.chamadas).toEqual([]);
  });

  it("vínculos simultâneos são serializados e emitem uma vez só", async () => {
    const a = aparelho();

    expect(await Promise.all([a.vinculo.vincular(a.obter), a.vinculo.vincular(a.obter)])).toEqual(["REGISTRADO", "REGISTRADO"]);
    expect(a.servidor.autorizacoes.size).toBe(1);
  });

  it("geração revogada em outro lugar: descarta a local e cria uma nova", async () => {
    const a = aparelho();
    await a.vinculo.vincular(a.obter);
    const [antiga] = await a.vinculo.pendentes();
    await a.servidor.api.revogar({ token: TOKEN, operationId: antiga.operationId, segredo: antiga.segredo });

    expect(await a.vinculo.vincular(a.obter)).toBe("REGISTRADO");
    const [nova] = await a.vinculo.pendentes();
    expect(nova.operationId).not.toBe(antiga.operationId);
    expect(a.servidor.vinculos.get(TOKEN)?.operationId).toBe(nova.operationId);
  });

  it("token renovado pela Expo: cancela a operação do token antigo e registra o novo", async () => {
    const a = aparelho();
    await a.vinculo.vincular(a.obter);

    expect(await a.vinculo.vincular(async () => TOKEN_NOVO)).toBe("REGISTRADO");
    expect(dono(a, TOKEN)).toBeNull();
    expect(dono(a, TOKEN_NOVO)).toBe("ana");
    expect((await a.vinculo.pendentes()).map((o) => o.token)).toEqual([TOKEN_NOVO]);
  });
});

describe("outra conta", () => {
  it("token preso a outra conta: recusa sem transferir e sem guardar operação inútil", async () => {
    const servidor = servidorSimulado();
    servidor.vinculos.set(TOKEN, { userId: "bia", operationId: null, vinculoId: "00000000-0000-4000-8000-999999999999" });
    const a = aparelho(servidor);

    expect(await a.vinculo.vincular(a.obter)).toBe("EM_OUTRA_CONTA");
    expect(dono(a)).toBe("bia");
    expect(await a.vinculo.pendentes()).toEqual([]);
  });

  it("troca de conta sem sair: revoga a operação da conta anterior pelo segredo e registra a nova", async () => {
    const a = aparelho();
    await a.vinculo.vincular(a.obter);
    a.servidor.estado.conta = "bia";

    expect(await a.vinculo.vincular(a.obter)).toBe("REGISTRADO");

    expect(a.servidor.estado.chamadas).toContain("revogar:sem-sessao");
    expect(dono(a)).toBe("bia");
    expect((await a.vinculo.pendentes()).map((o) => o.userId)).toEqual(["bia"]);
  });

  it("troca de conta com a revogação falhando: a nova conta não toma o token e a operação anterior é preservada", async () => {
    const a = aparelho();
    await a.vinculo.vincular(a.obter);
    a.servidor.estado.conta = "bia";
    vi.mocked(a.servidor.api.revogar).mockRejectedValueOnce(new RecusaDaApi(0, "SEM_CONEXAO"));

    expect(await a.vinculo.vincular(a.obter)).toBe("EM_OUTRA_CONTA");
    expect(dono(a)).toBe("ana");
    expect((await a.vinculo.pendentes()).map((o) => o.userId)).toEqual(["ana"]);

    expect(await a.vinculo.vincular(a.obter)).toBe("REGISTRADO");
    expect(dono(a)).toBe("bia");
  });
});

describe("saída da conta", () => {
  it("cancela no servidor e só então encerra a sessão", async () => {
    const a = aparelho();
    await a.vinculo.vincular(a.obter);

    await a.sair();

    expect(a.servidor.estado.chamadas.slice(-1)).toEqual(["cancelar:ana"]);
    expect(dono(a)).toBeNull();
    expect(a.sessao.aberta).toBe(false);
    expect(await a.vinculo.pendentes()).toEqual([]);
  });

  it("falha no cancelamento não é engolida: a sessão continua e a operação fica guardada", async () => {
    const a = aparelho();
    await a.vinculo.vincular(a.obter);
    a.servidor.estado.foraDoAr = true;

    await expect(a.sair()).rejects.toThrow();
    expect(a.sessao.aberta).toBe(true);
    expect(dono(a)).toBe("ana");
    expect(await a.vinculo.pendentes()).toHaveLength(1);

    a.servidor.estado.foraDoAr = false;
    await a.sair();
    expect(dono(a)).toBeNull();
  });

  it("sessão já expirada: revoga pelo segredo, sem sessão", async () => {
    const a = aparelho();
    await a.vinculo.vincular(a.obter);
    vi.mocked(a.servidor.api.cancelar).mockRejectedValueOnce(new RecusaDaApi(401, "NAO_AUTENTICADO"));

    await a.sair();

    expect(a.servidor.estado.chamadas).toContain("revogar:sem-sessao");
    expect(dono(a)).toBeNull();
  });

  it("espera o registro em andamento antes de cancelar, para não deixar vínculo criado depois da saída", async () => {
    const a = aparelho();
    let liberar: () => void = () => {};
    let avisarPedido: () => void = () => {};
    const pedido = new Promise<void>((resolve) => (avisarPedido = resolve));
    const tokenAtrasado = () => {
      avisarPedido();
      return new Promise<string>((resolve) => (liberar = () => resolve(TOKEN)));
    };

    const registro = a.vinculo.vincular(tokenAtrasado);
    const saida = a.sair();
    await pedido;
    liberar();
    await Promise.all([registro, saida]);

    expect(dono(a)).toBeNull();
    expect(a.sessao.aberta).toBe(false);
  });

  it("emissão com resposta perdida antes da saída: o cancelamento deixa registro terminal e o registro atrasado é recusado", async () => {
    const a = aparelho();
    a.servidor.estado.perderRespostaDe = "emitir";
    await a.vinculo.vincular(a.obter);
    const [pendente] = await a.vinculo.pendentes();

    await a.sair();

    const autorizacao = a.servidor.autorizacoes.get(pendente.operationId)!;
    expect(autorizacao.estado).toBe("CANCELADA");
    a.servidor.estado.conta = "ana";
    await expect(a.servidor.api.registrar({ token: TOKEN, operationId: pendente.operationId, comprovante: pendente.comprovante, vinculoId: autorizacao.vinculoId }))
      .rejects.toMatchObject({ code: "PUSH_AUTORIZACAO_TERMINAL" });
  });

  it("sem operação guardada, sai sem chamar o servidor", async () => {
    const a = aparelho();

    await a.sair();

    expect(a.servidor.estado.chamadas).toEqual([]);
    expect(a.sessao.aberta).toBe(false);
  });

  it("depois da saída confirmada, a conta seguinte registra o mesmo token", async () => {
    const a = aparelho();
    await a.vinculo.vincular(a.obter);
    await a.sair();
    a.servidor.estado.conta = "bia";

    expect(await a.vinculo.vincular(a.obter)).toBe("REGISTRADO");
    expect(dono(a)).toBe("bia");
  });

  it("a saída da conta que não é dona do token não desfaz o vínculo da outra", async () => {
    const servidor = servidorSimulado();
    servidor.vinculos.set(TOKEN, { userId: "bia", operationId: null, vinculoId: "00000000-0000-4000-8000-999999999999" });
    const a = aparelho(servidor);
    await a.vinculo.vincular(a.obter);

    await a.sair();

    expect(dono(a)).toBe("bia");
    expect(a.servidor.estado.chamadas).toEqual(["emitir:ana"]);
  });
});
