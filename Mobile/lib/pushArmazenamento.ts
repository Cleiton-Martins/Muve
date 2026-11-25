import { base64UrlDe32Bytes, operacaoValida } from "@muve/shared/pushComprovante.ts";

export const CHAVE_LEGADA_DAS_OPERACOES = "muve.push.operacoes.v1";
export const CHAVE_DO_INDICE = "muve.push.indice.v2";
export const PREFIXO_DA_OPERACAO = "muve.push.op.v2.";
export const TAMANHO_MAXIMO_DO_VALOR = 2048;
export const OPERACOES_MAXIMAS = 20;

export type FaseDaOperacao = "EMITINDO" | "EMITIDA" | "REGISTRADA";
export type IntencaoDaOperacao = "CREATE" | "ATTACH_LEGACY" | "REPLACE";

export interface OperacaoLocal {
  userId: string;
  token: string;
  operationId: string;
  segredo: string;
  comprovante: string;
  fase: FaseDaOperacao;
  vinculoId: string | null;
  intencao?: IntencaoDaOperacao | null;
}

export interface ArmazenamentoSeguro {
  disponivel(): Promise<boolean>;
  ler(chave: string): Promise<string | null>;
  gravar(chave: string, valor: string): Promise<void>;
  apagar(chave: string): Promise<void>;
}

export interface ArmazenamentoLegado {
  ler(chave: string): Promise<string | null>;
  apagar(chave: string): Promise<void>;
}

export class ArmazenamentoIndisponivel extends Error {
  constructor(motivo: string) {
    super(`Armazenamento protegido indisponível: ${motivo}`);
    this.name = "ArmazenamentoIndisponivel";
  }
}

const FASES: FaseDaOperacao[] = ["EMITINDO", "EMITIDA", "REGISTRADA"];
const INTENCOES: IntencaoDaOperacao[] = ["CREATE", "ATTACH_LEGACY", "REPLACE"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function temTrintaEDoisBytes(valor: unknown, campo: "segredo" | "comprovante"): boolean {
  try {
    base64UrlDe32Bytes(valor, campo);
    return true;
  } catch {
    return false;
  }
}

export function operacaoLocalValida(valor: unknown): valor is OperacaoLocal {
  if (typeof valor !== "object" || valor === null) return false;
  const o = valor as Record<string, unknown>;
  return typeof o.userId === "string" && o.userId.length > 0
    && typeof o.token === "string" && o.token.length > 0
    && operacaoValida(o.operationId)
    && temTrintaEDoisBytes(o.segredo, "segredo")
    && temTrintaEDoisBytes(o.comprovante, "comprovante")
    && FASES.includes(o.fase as FaseDaOperacao)
    && (o.vinculoId === null || (typeof o.vinculoId === "string" && UUID.test(o.vinculoId)))
    && (o.fase === "EMITINDO" || o.vinculoId !== null)
    && (o.intencao === undefined || o.intencao === null || INTENCOES.includes(o.intencao as IntencaoDaOperacao));
}

const bytesUtf8 = (texto: string) => new TextEncoder().encode(texto).length;
const chaveDa = (operationId: string) => `${PREFIXO_DA_OPERACAO}${operationId.toLowerCase()}`;
const serializar = (o: OperacaoLocal) =>
  JSON.stringify({ userId: o.userId, token: o.token, operationId: o.operationId, segredo: o.segredo, comprovante: o.comprovante, fase: o.fase, vinculoId: o.vinculoId, intencao: o.intencao ?? null });

function lerJson(texto: string): unknown {
  try {
    return JSON.parse(texto);
  } catch {
    return undefined;
  }
}

export function criarArmazenamentoDePush(deps: { seguro: ArmazenamentoSeguro; legado?: ArmazenamentoLegado }) {
  const { seguro, legado } = deps;
  let preparado = false;

  async function chamar<T>(acao: () => Promise<T>, motivo: string): Promise<T> {
    try {
      return await acao();
    } catch (error) {
      if (error instanceof ArmazenamentoIndisponivel) throw error;
      throw new ArmazenamentoIndisponivel(motivo);
    }
  }

  async function lerIndice(): Promise<string[]> {
    const bruto = await chamar(() => seguro.ler(CHAVE_DO_INDICE), "falha ao ler o índice");
    if (bruto === null) return [];
    const indice = lerJson(bruto);
    if (!Array.isArray(indice) || !indice.every(operacaoValida)) throw new ArmazenamentoIndisponivel("índice ilegível");
    return indice;
  }

  async function gravarConferindo(chave: string, valor: string): Promise<void> {
    if (bytesUtf8(valor) > TAMANHO_MAXIMO_DO_VALOR) throw new ArmazenamentoIndisponivel("registro maior que o limite do armazenamento");
    await chamar(() => seguro.gravar(chave, valor), "falha ao gravar");
    const relido = await chamar(() => seguro.ler(chave), "falha ao conferir a gravação");
    if (relido !== valor) throw new ArmazenamentoIndisponivel("a gravação não confere");
  }

  async function gravarIndice(indice: string[]): Promise<void> {
    if (indice.length === 0) await chamar(() => seguro.apagar(CHAVE_DO_INDICE), "falha ao apagar o índice");
    else await gravarConferindo(CHAVE_DO_INDICE, JSON.stringify(indice));
  }

  async function salvarSemPreparar(operacao: OperacaoLocal): Promise<void> {
    if (!operacaoLocalValida(operacao)) throw new ArmazenamentoIndisponivel("operação local incompleta");
    const indice = await lerIndice();
    const nova = !indice.includes(operacao.operationId);
    if (nova && indice.length >= OPERACOES_MAXIMAS) throw new ArmazenamentoIndisponivel("operações demais guardadas no aparelho");
    await gravarConferindo(chaveDa(operacao.operationId), serializar(operacao));
    if (nova) await gravarIndice([...indice, operacao.operationId]);
  }

  async function migrarLegado(): Promise<void> {
    if (!legado) return;
    const bruto = await chamar(() => legado.ler(CHAVE_LEGADA_DAS_OPERACOES), "falha ao ler os registros antigos");
    if (bruto === null) return;
    const lista = lerJson(bruto);
    if (!Array.isArray(lista) || !lista.every(operacaoLocalValida)) {
      throw new ArmazenamentoIndisponivel("registros antigos ilegíveis; preservados sem uso");
    }
    for (const operacao of lista) await salvarSemPreparar(operacao);
    await chamar(() => legado.apagar(CHAVE_LEGADA_DAS_OPERACOES), "falha ao apagar os registros antigos já copiados");
  }

  async function preparar(): Promise<void> {
    if (preparado) return;
    const disponivel = await chamar(() => seguro.disponivel(), "falha ao consultar o armazenamento");
    if (!disponivel) throw new ArmazenamentoIndisponivel("armazenamento protegido ausente neste ambiente");
    await migrarLegado();
    preparado = true;
  }

  return {
    async listar(): Promise<OperacaoLocal[]> {
      await preparar();
      const operacoes: OperacaoLocal[] = [];
      for (const operationId of await lerIndice()) {
        const bruto = await chamar(() => seguro.ler(chaveDa(operationId)), "falha ao ler uma operação");
        const operacao = bruto === null ? undefined : lerJson(bruto);
        if (operacaoLocalValida(operacao) && operacao.operationId === operationId) operacoes.push(operacao);
      }
      return operacoes;
    },

    async salvar(operacao: OperacaoLocal): Promise<void> {
      await preparar();
      await salvarSemPreparar(operacao);
    },

    async remover(operationId: string): Promise<void> {
      await preparar();
      const indice = await lerIndice();
      if (indice.includes(operationId)) await gravarIndice(indice.filter((id) => id !== operationId));
      await chamar(() => seguro.apagar(chaveDa(operationId)), "falha ao apagar a operação");
    },
  };
}

export type ArmazenamentoDePush = ReturnType<typeof criarArmazenamentoDePush>;
