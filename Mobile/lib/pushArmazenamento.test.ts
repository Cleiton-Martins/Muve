import { describe, expect, it } from "vitest";
import {
  ArmazenamentoIndisponivel,
  CHAVE_DO_INDICE,
  CHAVE_LEGADA_DAS_OPERACOES,
  criarArmazenamentoDePush,
  OPERACOES_MAXIMAS,
  PREFIXO_DA_OPERACAO,
  TAMANHO_MAXIMO_DO_VALOR,
  type OperacaoLocal,
} from "./pushArmazenamento";

const SEGREDO = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const operacao = (n: number, extra: Partial<OperacaoLocal> = {}): OperacaoLocal => ({
  userId: "00000000-0000-4000-8000-0000000000a1",
  token: "ExponentPushToken[ficticio]",
  operationId: `0f1e2d3c-4b5a-4968-8778-${String(n).padStart(12, "0")}`,
  segredo: SEGREDO,
  comprovante: "VhsRpuvOTeBJKdmXLpADaavBQggkp4jI1dnjzGKPvZ8",
  fase: "EMITINDO",
  vinculoId: null,
  intencao: null,
  ...extra,
});

function seguroSimulado() {
  const dados = new Map<string, string>();
  const s = {
    dados,
    disponivelNoAparelho: true,
    falhar: { ler: false, gravar: false, apagar: false },
    adulterar: false,
    gravacoes: [] as string[],
    disponivel: async () => s.disponivelNoAparelho,
    ler: async (chave: string) => {
      if (s.falhar.ler) throw new Error("keychain bloqueado");
      return dados.get(chave) ?? null;
    },
    gravar: async (chave: string, valor: string) => {
      if (s.falhar.gravar) throw new Error("valor recusado");
      s.gravacoes.push(chave);
      dados.set(chave, s.adulterar ? `${valor} ` : valor);
    },
    apagar: async (chave: string) => {
      if (s.falhar.apagar) throw new Error("falha ao apagar");
      dados.delete(chave);
    },
  };
  return s;
}

function legadoSimulado(valor?: string) {
  const dados = new Map<string, string>(valor === undefined ? [] : [[CHAVE_LEGADA_DAS_OPERACOES, valor]]);
  return { dados, ler: async (chave: string) => dados.get(chave) ?? null, apagar: async (chave: string) => void dados.delete(chave) };
}

const bytes = (texto: string) => new TextEncoder().encode(texto).length;

describe("armazenamento protegido das operações", () => {
  it("cada operação tem sua chave, com índice; salvar substitui pelo operation_id; remover apaga", async () => {
    const s = seguroSimulado();
    const armazenamento = criarArmazenamentoDePush({ seguro: s });

    await armazenamento.salvar(operacao(1));
    await armazenamento.salvar(operacao(2, { userId: "00000000-0000-4000-8000-0000000000b1" }));
    await armazenamento.salvar(operacao(1, { fase: "EMITIDA", vinculoId: "33333333-3333-4333-8333-333333333333", intencao: "CREATE" }));

    expect(await armazenamento.listar()).toEqual([
      operacao(1, { fase: "EMITIDA", vinculoId: "33333333-3333-4333-8333-333333333333", intencao: "CREATE" }),
      operacao(2, { userId: "00000000-0000-4000-8000-0000000000b1" }),
    ]);
    expect([...s.dados.keys()].sort()).toEqual([CHAVE_DO_INDICE, `${PREFIXO_DA_OPERACAO}${operacao(1).operationId}`, `${PREFIXO_DA_OPERACAO}${operacao(2).operationId}`].sort());
    expect([...s.dados.keys()].every((chave) => /^[\w.-]+$/.test(chave))).toBe(true);

    await armazenamento.remover(operacao(1).operationId);
    await armazenamento.remover(operacao(2).operationId);
    expect(s.dados.size).toBe(0);
  });

  it("sem armazenamento protegido disponível, recusa e não grava em lugar nenhum", async () => {
    const s = seguroSimulado();
    s.disponivelNoAparelho = false;
    const armazenamento = criarArmazenamentoDePush({ seguro: s });

    await expect(armazenamento.salvar(operacao(1))).rejects.toBeInstanceOf(ArmazenamentoIndisponivel);
    await expect(armazenamento.listar()).rejects.toBeInstanceOf(ArmazenamentoIndisponivel);
    expect(s.gravacoes).toEqual([]);
  });

  it("registro acima do limite de 2.048 bytes é recusado antes de gravar e não apaga o anterior", async () => {
    const s = seguroSimulado();
    const armazenamento = criarArmazenamentoDePush({ seguro: s });
    await armazenamento.salvar(operacao(1));
    const gravacoesAntes = s.gravacoes.length;

    await expect(armazenamento.salvar(operacao(1, { token: `ExponentPushToken[${"x".repeat(2100)}]` }))).rejects.toBeInstanceOf(ArmazenamentoIndisponivel);
    expect(s.gravacoes.length).toBe(gravacoesAntes);
    expect(await armazenamento.listar()).toEqual([operacao(1)]);
  });

  it("tamanho real serializado: o maior registro aceito pela API e o índice cheio cabem com folga", async () => {
    const s = seguroSimulado();
    const armazenamento = criarArmazenamentoDePush({ seguro: s });
    const tokenMaximo = `ExponentPushToken[${"🎵".repeat(90)}]`;
    expect(tokenMaximo.length).toBeLessThanOrEqual(200);

    for (let n = 1; n <= OPERACOES_MAXIMAS; n++) {
      await armazenamento.salvar(operacao(n, { token: tokenMaximo, fase: "REGISTRADA", vinculoId: "33333333-3333-4333-8333-333333333333", intencao: "ATTACH_LEGACY" }));
    }

    const maiorValor = Math.max(...[...s.dados.values()].map(bytes));
    expect(maiorValor).toBeLessThan(TAMANHO_MAXIMO_DO_VALOR / 2);
    expect(bytes(s.dados.get(CHAVE_DO_INDICE)!)).toBeLessThan(TAMANHO_MAXIMO_DO_VALOR);
  });

  it("limite de operações guardadas", async () => {
    const armazenamento = criarArmazenamentoDePush({ seguro: seguroSimulado() });
    for (let n = 1; n <= OPERACOES_MAXIMAS; n++) await armazenamento.salvar(operacao(n));

    await expect(armazenamento.salvar(operacao(OPERACOES_MAXIMAS + 1))).rejects.toBeInstanceOf(ArmazenamentoIndisponivel);
    await expect(armazenamento.salvar(operacao(1, { fase: "EMITIDA", vinculoId: "33333333-3333-4333-8333-333333333333" }))).resolves.toBeUndefined();
  });

  it("gravação que não confere na releitura é tratada como falha", async () => {
    const s = seguroSimulado();
    s.adulterar = true;

    await expect(criarArmazenamentoDePush({ seguro: s }).salvar(operacao(1))).rejects.toBeInstanceOf(ArmazenamentoIndisponivel);
  });

  it("falhas de leitura, gravação e exclusão viram erro controlado, nunca lista vazia, e sem expor o segredo", async () => {
    for (const falha of ["ler", "gravar", "apagar"] as const) {
      const s = seguroSimulado();
      const armazenamento = criarArmazenamentoDePush({ seguro: s });
      await armazenamento.salvar(operacao(1));
      s.falhar[falha] = true;
      const acao = falha === "ler" ? armazenamento.listar() : falha === "gravar" ? armazenamento.salvar(operacao(2)) : armazenamento.remover(operacao(1).operationId);

      const erro = await acao.then(() => null, (e: unknown) => e);
      expect(erro).toBeInstanceOf(ArmazenamentoIndisponivel);
      expect(String((erro as Error).message)).not.toContain(SEGREDO);
    }
  });

  it("operação malformada é recusada antes de gravar", async () => {
    const s = seguroSimulado();
    const armazenamento = criarArmazenamentoDePush({ seguro: s });

    await expect(armazenamento.salvar(operacao(1, { segredo: "curto" }))).rejects.toBeInstanceOf(ArmazenamentoIndisponivel);
    await expect(armazenamento.salvar(operacao(1, { userId: "" }))).rejects.toBeInstanceOf(ArmazenamentoIndisponivel);
    expect(s.gravacoes).toEqual([]);
  });
});

describe("migração dos registros antigos do AsyncStorage", () => {
  it("copia para o armazenamento protegido, confere e só então apaga a cópia antiga", async () => {
    const s = seguroSimulado();
    const antigos = [operacao(1), operacao(2, { userId: "00000000-0000-4000-8000-0000000000b1", fase: "REGISTRADA", vinculoId: "33333333-3333-4333-8333-333333333333" })];
    const legado = legadoSimulado(JSON.stringify(antigos.map(({ intencao: _intencao, ...resto }) => resto)));

    const lista = await criarArmazenamentoDePush({ seguro: s, legado }).listar();

    expect(lista.map((o) => [o.userId, o.operationId, o.fase])).toEqual(antigos.map((o) => [o.userId, o.operationId, o.fase]));
    expect(legado.dados.has(CHAVE_LEGADA_DAS_OPERACOES)).toBe(false);
  });

  it("registros antigos ilegíveis ou sem conta: preserva, não migra e bloqueia a operação", async () => {
    for (const bruto of ["{nao-e-json", JSON.stringify([operacao(1), { userId: "" }])]) {
      const s = seguroSimulado();
      const legado = legadoSimulado(bruto);
      const armazenamento = criarArmazenamentoDePush({ seguro: s, legado });

      await expect(armazenamento.listar()).rejects.toBeInstanceOf(ArmazenamentoIndisponivel);
      await expect(armazenamento.salvar(operacao(9))).rejects.toBeInstanceOf(ArmazenamentoIndisponivel);
      expect(legado.dados.get(CHAVE_LEGADA_DAS_OPERACOES)).toBe(bruto);
      expect(s.gravacoes).toEqual([]);
    }
  });

  it("falha na cópia: a cópia antiga continua guardada e a migração é retomada depois", async () => {
    const s = seguroSimulado();
    const legado = legadoSimulado(JSON.stringify([operacao(1)]));
    s.falhar.gravar = true;
    const armazenamento = criarArmazenamentoDePush({ seguro: s, legado });

    await expect(armazenamento.listar()).rejects.toBeInstanceOf(ArmazenamentoIndisponivel);
    expect(legado.dados.has(CHAVE_LEGADA_DAS_OPERACOES)).toBe(true);

    s.falhar.gravar = false;
    expect((await armazenamento.listar()).map((o) => o.operationId)).toEqual([operacao(1).operationId]);
    expect(legado.dados.has(CHAVE_LEGADA_DAS_OPERACOES)).toBe(false);
  });

  it("sem registros antigos, nada é tocado no AsyncStorage", async () => {
    const legado = legadoSimulado();

    expect(await criarArmazenamentoDePush({ seguro: seguroSimulado(), legado }).listar()).toEqual([]);
  });
});
