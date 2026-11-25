import type { AutorizacaoDePush, EncerramentoDePush, RegistroDePush } from "@muve/shared/contratos.ts";
import { bytesParaBase64Url, calcularComprovante, operacaoValida, PUSH_SEGREDO_BYTES } from "@muve/shared/pushComprovante.ts";
import type { ArmazenamentoDePush, IntencaoDaOperacao, OperacaoLocal } from "./pushArmazenamento";

export const DISPOSITIVO_EM_OUTRA_CONTA = "DISPOSITIVO_EM_OUTRA_CONTA";

export type SituacaoDoVinculo = "SEM_TOKEN" | "INATIVO" | "REGISTRADO" | "EM_OUTRA_CONTA" | "FALHOU" | "INDISPONIVEL";

export interface OperacaoEnviada {
  token: string;
  operationId: string;
  comprovante: string;
}

export interface ApiDePush {
  emitir(operacao: OperacaoEnviada): Promise<AutorizacaoDePush>;
  registrar(operacao: OperacaoEnviada & { vinculoId: string }): Promise<RegistroDePush>;
  cancelar(operacao: OperacaoEnviada): Promise<EncerramentoDePush>;
  revogar(dados: { token: string; operationId: string; segredo: string }): Promise<EncerramentoDePush>;
}

export interface DependenciasDoVinculo {
  api: ApiDePush;
  armazenamento: ArmazenamentoDePush;
  contaAtual(): Promise<string | null>;
  gerarOperacao(): string;
  gerarSegredo(): Promise<Uint8Array>;
}

export class GeracaoInsegura extends Error {
  constructor(campo: "operationId" | "segredo") {
    super(`Geração segura de ${campo} falhou.`);
    this.name = "GeracaoInsegura";
  }
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INTENCAO_POR_ESTADO: Record<AutorizacaoDePush["estadoEsperado"], IntencaoDaOperacao> = { AUSENTE: "CREATE", LEGADO: "ATTACH_LEGACY", VINCULADO: "REPLACE" };

const statusDe = (error: unknown) =>
  typeof error === "object" && error !== null && typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : 0;
const codigoDe = (error: unknown) => (typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined);
const respostaDefinitiva = (error: unknown) => {
  const status = statusDe(error);
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
};
const emissaoRecusada = (error: unknown) => respostaDefinitiva(error) || statusDe(error) === 429;
const enviada = (operacao: OperacaoLocal): OperacaoEnviada => ({ token: operacao.token, operationId: operacao.operationId, comprovante: operacao.comprovante });

export function criarVinculoDePush(deps: DependenciasDoVinculo) {
  const { api, armazenamento } = deps;
  let fila: Promise<unknown> = Promise.resolve();

  function emSequencia<T>(tarefa: () => Promise<T>): Promise<T> {
    const resultado = fila.then(tarefa, tarefa);
    fila = resultado.catch(() => {});
    return resultado;
  }

  async function encerrarSemSessao(operacao: OperacaoLocal): Promise<boolean> {
    let resposta: EncerramentoDePush;
    try {
      resposta = await api.revogar({ token: operacao.token, operationId: operacao.operationId, segredo: operacao.segredo });
    } catch {
      return false;
    }
    if (resposta.resultado === "NEGADA") return false;
    await armazenamento.remover(operacao.operationId);
    return true;
  }

  async function encerrarComSessao(operacao: OperacaoLocal): Promise<boolean> {
    try {
      await api.cancelar(enviada(operacao));
    } catch (error) {
      if (statusDe(error) === 401) return encerrarSemSessao(operacao);
      if (!respostaDefinitiva(error)) return false;
    }
    await armazenamento.remover(operacao.operationId);
    return true;
  }

  async function concluir(operacao: OperacaoLocal): Promise<SituacaoDoVinculo> {
    let atual = operacao;
    if (atual.fase === "EMITINDO") {
      let autorizacao: AutorizacaoDePush;
      try {
        autorizacao = await api.emitir(enviada(atual));
      } catch (error) {
        if (!emissaoRecusada(error)) return "FALHOU";
        await armazenamento.remover(atual.operationId);
        return codigoDe(error) === DISPOSITIVO_EM_OUTRA_CONTA ? "EM_OUTRA_CONTA" : "FALHOU";
      }
      if (autorizacao.resultado === "TERMINAL") {
        await armazenamento.remover(atual.operationId);
        return "FALHOU";
      }
      atual = { ...atual, fase: "EMITIDA", vinculoId: autorizacao.vinculoId, intencao: INTENCAO_POR_ESTADO[autorizacao.estadoEsperado] ?? null };
      await armazenamento.salvar(atual);
    }
    try {
      await api.registrar({ ...enviada(atual), vinculoId: atual.vinculoId! });
    } catch (error) {
      if (!respostaDefinitiva(error)) return "FALHOU";
      if (atual.fase === "REGISTRADA") await armazenamento.remover(atual.operationId);
      else await encerrarComSessao(atual);
      return "FALHOU";
    }
    if (atual.fase !== "REGISTRADA") await armazenamento.salvar({ ...atual, fase: "REGISTRADA" });
    return "REGISTRADO";
  }

  async function criarOperacao(userId: string, token: string): Promise<OperacaoLocal> {
    const operationId = String(deps.gerarOperacao()).toLowerCase();
    if (!operacaoValida(operationId) || !UUID_V4.test(operationId)) throw new GeracaoInsegura("operationId");
    const segredo = await deps.gerarSegredo();
    if (!(segredo instanceof Uint8Array) || segredo.length !== PUSH_SEGREDO_BYTES) throw new GeracaoInsegura("segredo");
    const operacao: OperacaoLocal = {
      userId,
      token,
      operationId,
      segredo: bytesParaBase64Url(segredo),
      comprovante: bytesParaBase64Url(calcularComprovante(token, operationId, segredo)),
      fase: "EMITINDO",
      vinculoId: null,
      intencao: null,
    };
    await armazenamento.salvar(operacao);
    return operacao;
  }

  async function vincularAgora(userId: string, token: string): Promise<SituacaoDoVinculo> {
    const operacoes = await armazenamento.listar();
    for (const deOutraConta of operacoes.filter((item) => item.userId !== userId)) await encerrarSemSessao(deOutraConta);
    for (const deOutroToken of operacoes.filter((item) => item.userId === userId && item.token !== token)) await encerrarComSessao(deOutroToken);

    for (const existente of operacoes.filter((item) => item.userId === userId && item.token === token)) {
      const situacao = await concluir(existente);
      if (situacao === "REGISTRADO" || situacao === "EM_OUTRA_CONTA") return situacao;
      if ((await armazenamento.listar()).some((item) => item.operationId === existente.operationId)) return situacao;
    }

    let operacao: OperacaoLocal;
    try {
      operacao = await criarOperacao(userId, token);
    } catch {
      return "INDISPONIVEL";
    }
    return concluir(operacao);
  }

  return {
    vincular(obterToken: () => Promise<string | null>, ativo: () => boolean = () => true): Promise<SituacaoDoVinculo> {
      return emSequencia(async () => {
        const token = await obterToken().catch(() => null);
        if (!token) return "SEM_TOKEN";
        if (!ativo()) return "INATIVO";
        const userId = await deps.contaAtual().catch(() => null);
        if (!userId || !ativo()) return "INATIVO";
        try {
          return await vincularAgora(userId, token);
        } catch {
          return "FALHOU";
        }
      });
    },

    desvincular(): Promise<void> {
      return emSequencia(async () => {
        const userId = await deps.contaAtual().catch(() => null);
        const operacoes = await armazenamento.listar();
        for (const operacao of userId ? operacoes.filter((item) => item.userId === userId) : operacoes) {
          const encerrada = userId ? await encerrarComSessao(operacao) : await encerrarSemSessao(operacao);
          if (!encerrada) throw new Error("Não foi possível desligar os avisos deste aparelho.");
        }
      });
    },

    pendentes(): Promise<OperacaoLocal[]> {
      return armazenamento.listar();
    },
  };
}

export async function sairDaConta(deps: { desvincular: () => Promise<void>; encerrarSessao: () => Promise<void> }): Promise<void> {
  await deps.desvincular();
  await deps.encerrarSessao();
}
