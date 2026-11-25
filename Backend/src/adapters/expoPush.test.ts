import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createExpoPush, DISPOSITIVO_EM_OUTRA_CONTA } from "./expoPush.ts";

const ANA = "11111111-1111-4111-8111-111111111111";
const BIA = "22222222-2222-4222-8222-222222222222";
const TOKEN = "ExponentPushToken[ficticio-aparelho-1]";
const OUTRO_TOKEN = "ExponentPushToken[ficticio-aparelho-2]";
const OPERACAO = "0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e";
const VINCULO = "33333333-3333-4333-8333-333333333333";
const COMPROVANTE = "VhsRpuvOTeBJKdmXLpADaavBQggkp4jI1dnjzGKPvZ8";
const COMPROVANTE_HEX = "\\x561b11a6ebce4de04929d9972e900369abc1420824a788c8d5d9e3cc628fbd9f";

interface Vinculo {
  token: string;
  user_id: string;
  operation_id: string | null;
}

type Resposta = { data: unknown; error: { message: string; code?: string } | null };

function cenario(vinculos: Vinculo[] = []) {
  const chamadas: { nome: string; args: Record<string, unknown> }[] = [];
  const respostas = new Map<string, Resposta[]>();
  const escritasDiretas: string[] = [];

  const admin = {
    from(tabela: string) {
      const filtros: [keyof Vinculo, string][] = [];
      const linhas = () => vinculos.filter((linha) => filtros.every(([coluna, valor]) => linha[coluna] === valor));
      const consulta = {
        select: () => consulta,
        eq(coluna: keyof Vinculo, valor: string) {
          filtros.push([coluna, valor]);
          return consulta;
        },
        maybeSingle: async () => ({ data: linhas()[0] ?? null, error: null }),
        then<A>(aoResolver: (resultado: Resposta) => A) {
          return Promise.resolve({ data: linhas(), error: null }).then(aoResolver);
        },
        insert: () => void escritasDiretas.push(`insert ${tabela}`),
        update: () => void escritasDiretas.push(`update ${tabela}`),
        delete: () => void escritasDiretas.push(`delete ${tabela}`),
        upsert: () => void escritasDiretas.push(`upsert ${tabela}`),
      };
      return consulta;
    },
    async rpc(nome: string, args: Record<string, unknown>): Promise<Resposta> {
      chamadas.push({ nome, args });
      const fila = respostas.get(nome) ?? [];
      return fila.length > 1 ? fila.shift()! : (fila[0] ?? { data: null, error: { message: "sem resposta simulada" } });
    },
  };

  return {
    push: createExpoPush(admin as unknown as SupabaseClient),
    chamadas,
    escritasDiretas,
    responder(nome: string, ...lista: Resposta[]) {
      respostas.set(nome, lista);
    },
  };
}

const emitida = (resultado = "EMITIDA", estadoEsperado = "AUSENTE") => ({
  data: [{ operation_id: OPERACAO, target_vinculo_id: VINCULO, expected_state: estadoEsperado, expected_vinculo_id: null, estado: "PENDENTE", expira_em: "2030-01-01T00:10:00Z", resultado }],
  error: null,
});
const erro = (message: string): Resposta => ({ data: null, error: { message, code: "P0001" } });
const operacao = { token: TOKEN, operationId: OPERACAO, comprovante: COMPROVANTE };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("emissão de autorização", () => {
  it.each([
    ["sem vínculo", [], "CREATE"],
    ["vínculo legado da própria conta", [{ token: TOKEN, user_id: ANA, operation_id: null }], "ATTACH_LEGACY"],
    ["vínculo com comprovante da própria conta", [{ token: TOKEN, user_id: ANA, operation_id: OPERACAO }], "REPLACE"],
    ["vínculo de outra conta (o banco recusa)", [{ token: TOKEN, user_id: BIA, operation_id: null }], "CREATE"],
  ] as const)("%s: intenção %s a partir do estado persistido", async (_caso, vinculos, intencao) => {
    const c = cenario([...vinculos]);
    c.responder("push_emitir_autorizacao", emitida());

    await c.push.emitir(ANA, operacao);

    expect(c.chamadas).toEqual([
      { nome: "push_emitir_autorizacao", args: { p_user_id: ANA, p_operation_id: OPERACAO, p_token: TOKEN, p_comprovante: COMPROVANTE_HEX, p_intencao: intencao } },
    ]);
  });

  it("devolve a autorização no contrato compartilhado", async () => {
    const c = cenario();
    c.responder("push_emitir_autorizacao", emitida("JA_EMITIDA"));

    await expect(c.push.emitir(ANA, operacao)).resolves.toEqual({
      operationId: OPERACAO,
      vinculoId: VINCULO,
      estadoEsperado: "AUSENTE",
      estado: "PENDENTE",
      expiraEm: "2030-01-01T00:10:00Z",
      resultado: "JA_EMITIDA",
    });
  });

  it("token em outra conta vira 409 sem transferir nada", async () => {
    const c = cenario([{ token: TOKEN, user_id: BIA, operation_id: null }]);
    c.responder("push_emitir_autorizacao", erro("DISPOSITIVO_EM_OUTRA_CONTA"));

    await expect(c.push.emitir(ANA, operacao)).rejects.toMatchObject({ status: 409, code: DISPOSITIVO_EM_OUTRA_CONTA });
    expect(c.escritasDiretas).toEqual([]);
  });

  it("estado alterado entre a leitura e a emissão: relê e tenta uma vez", async () => {
    const c = cenario();
    c.responder("push_emitir_autorizacao", erro("PUSH_INTENCAO_INCOMPATIVEL"), emitida());

    await expect(c.push.emitir(ANA, operacao)).resolves.toMatchObject({ resultado: "EMITIDA" });
    expect(c.chamadas).toHaveLength(2);
  });

  it("estado alterado de novo: 409 em vez de sucesso", async () => {
    const c = cenario();
    c.responder("push_emitir_autorizacao", erro("PUSH_INTENCAO_INCOMPATIVEL"), erro("PUSH_INTENCAO_INCOMPATIVEL"));

    await expect(c.push.emitir(ANA, operacao)).rejects.toMatchObject({ status: 409, code: "PUSH_ESTADO_ALTERADO" });
  });

  it("pendências esgotadas: encerra as vencidas e tenta de novo", async () => {
    const c = cenario();
    c.responder("push_emitir_autorizacao", erro("PUSH_PENDENTES_EXCEDIDAS"), emitida());
    c.responder("push_encerrar_expiradas", { data: 2, error: null });

    await expect(c.push.emitir(ANA, operacao)).resolves.toMatchObject({ resultado: "EMITIDA" });
    expect(c.chamadas.map((chamada) => chamada.nome)).toEqual(["push_emitir_autorizacao", "push_encerrar_expiradas", "push_emitir_autorizacao"]);
    expect(c.chamadas[1].args).toEqual({ p_limite: 100 });
  });

  it.each([
    ["PUSH_PARAMETROS_AUSENTES", 503, "PUSH_INDISPONIVEL"],
    ["PUSH_CAPACIDADE_ESGOTADA", 503, "PUSH_INDISPONIVEL"],
    ["PUSH_FREQUENCIA_EXCEDIDA", 429, "PUSH_LIMITE"],
    ["PUSH_LIMITE_DA_CONTA", 429, "PUSH_LIMITE"],
    ["PUSH_OPERACAO_CONFLITANTE", 409, "PUSH_OPERACAO_CONFLITANTE"],
    ["PUSH_TOKEN_INVALIDO", 400, "PUSH_DADOS_INVALIDOS"],
  ])("%s vira %i %s (falha segura)", async (codigoDoBanco, status, code) => {
    const c = cenario();
    c.responder("push_emitir_autorizacao", erro(codigoDoBanco));

    await expect(c.push.emitir(ANA, operacao)).rejects.toMatchObject({ status, code });
  });

  it("erro desconhecido do banco é repassado, nunca tratado como sucesso", async () => {
    const c = cenario();
    c.responder("push_emitir_autorizacao", { data: null, error: { message: "connection reset", code: "08006" } });

    await expect(c.push.emitir(ANA, operacao)).rejects.toMatchObject({ message: "connection reset" });
  });

  it("resposta vazia do banco é erro, não confirmação", async () => {
    const c = cenario();
    c.responder("push_emitir_autorizacao", { data: [], error: null });

    await expect(c.push.emitir(ANA, operacao)).rejects.toThrow("não devolveu resultado");
  });
});

describe("registro, cancelamento, remoção legada e revogação", () => {
  it("registro manda a geração emitida e devolve a geração gravada", async () => {
    const c = cenario();
    c.responder("push_registrar_token", { data: [{ vinculo_id: VINCULO, resultado: "REGISTRADO" }], error: null });

    await expect(c.push.registrar(ANA, { ...operacao, vinculoId: VINCULO })).resolves.toEqual({ vinculoId: VINCULO, resultado: "REGISTRADO" });
    expect(c.chamadas[0]).toEqual({
      nome: "push_registrar_token",
      args: { p_user_id: ANA, p_operation_id: OPERACAO, p_token: TOKEN, p_comprovante: COMPROVANTE_HEX, p_target_vinculo_id: VINCULO },
    });
  });

  it.each([
    ["PUSH_GERACAO_SUBSTITUIDA", "PUSH_GERACAO_SUBSTITUIDA"],
    ["PUSH_ESTADO_DIVERGENTE", "PUSH_ESTADO_ALTERADO"],
    ["PUSH_AUTORIZACAO_TERMINAL", "PUSH_AUTORIZACAO_TERMINAL"],
    ["PUSH_AUTORIZACAO_EXPIRADA", "PUSH_AUTORIZACAO_EXPIRADA"],
    ["PUSH_AUTORIZACAO_NAO_CONFERE", "PUSH_AUTORIZACAO_NAO_CONFERE"],
  ])("registro recusado pelo banco (%s) vira 409 %s", async (codigoDoBanco, code) => {
    const c = cenario();
    c.responder("push_registrar_token", erro(codigoDoBanco));

    await expect(c.push.registrar(ANA, { ...operacao, vinculoId: VINCULO })).rejects.toMatchObject({ status: 409, code });
  });

  it("cancelamento devolve o estado persistido", async () => {
    const c = cenario();
    c.responder("push_cancelar_operacao", { data: [{ estado: "CANCELADA", resultado: "CANCELADA_SEM_EMISSAO" }], error: null });

    await expect(c.push.cancelar(ANA, operacao)).resolves.toEqual({ estado: "CANCELADA", resultado: "CANCELADA_SEM_EMISSAO" });
    expect(c.chamadas[0].args).toEqual({ p_user_id: ANA, p_operation_id: OPERACAO, p_token: TOKEN, p_comprovante: COMPROVANTE_HEX });
  });

  it("cancelamento durante a exclusão da conta não vira sucesso", async () => {
    const c = cenario();
    c.responder("push_cancelar_operacao", erro("PUSH_CONTA_INEXISTENTE"));

    await expect(c.push.cancelar(ANA, operacao)).rejects.toMatchObject({ status: 409, code: "PUSH_CONTA_INEXISTENTE" });
  });

  it("remoção legada só pelo dono", async () => {
    const c = cenario();
    c.responder("push_remover_vinculo_legado", { data: "COM_COMPROVANTE", error: null });

    await expect(c.push.removerLegado(ANA, TOKEN)).resolves.toEqual({ estado: null, resultado: "COM_COMPROVANTE" });
    expect(c.chamadas[0]).toEqual({ nome: "push_remover_vinculo_legado", args: { p_user_id: ANA, p_token: TOKEN } });
  });

  it.each(["REVOGADA", "JA_ENCERRADA", "DESCONHECIDA", "NEGADA"])("revogação devolve o resultado do banco sem reinterpretar (%s)", async (resultado) => {
    const c = cenario();
    c.responder("push_revogar_por_segredo", { data: [{ estado: resultado === "REVOGADA" ? "REVOGADA" : null, resultado }], error: null });

    await expect(c.push.revogar(operacao)).resolves.toMatchObject({ resultado });
    expect(c.chamadas[0].args).toEqual({ p_operation_id: OPERACAO, p_token: TOKEN, p_comprovante: COMPROVANTE_HEX });
  });

  it("nenhuma operação grava direto nas tabelas protegidas", async () => {
    const c = cenario([{ token: TOKEN, user_id: ANA, operation_id: OPERACAO }]);
    c.responder("push_emitir_autorizacao", emitida());
    c.responder("push_registrar_token", { data: [{ vinculo_id: VINCULO, resultado: "REGISTRADO" }], error: null });
    c.responder("push_cancelar_operacao", { data: [{ estado: "CANCELADA", resultado: "CANCELADA" }], error: null });
    c.responder("push_remover_vinculo_legado", { data: "REMOVIDO", error: null });
    c.responder("push_revogar_por_segredo", { data: [{ estado: "REVOGADA", resultado: "REVOGADA" }], error: null });

    await c.push.emitir(ANA, operacao);
    await c.push.registrar(ANA, { ...operacao, vinculoId: VINCULO });
    await c.push.cancelar(ANA, operacao);
    await c.push.removerLegado(ANA, TOKEN);
    await c.push.revogar(operacao);

    expect(c.escritasDiretas).toEqual([]);
  });
});

describe("limpeza de token inválido no envio", () => {
  it("usa a função do banco, só para o destinatário", async () => {
    const c = cenario([
      { token: TOKEN, user_id: ANA, operation_id: OPERACAO },
      { token: OUTRO_TOKEN, user_id: BIA, operation_id: null },
    ]);
    c.responder("push_limpar_token_invalido", { data: "REMOVIDO", error: null });
    const requisicao = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [{ status: "error", details: { error: "DeviceNotRegistered" } }] }) }));
    vi.stubGlobal("fetch", requisicao);

    await c.push.send(ANA, { titulo: "Aviso", texto: "Texto", link: null });

    expect(requisicao).toHaveBeenCalledOnce();
    expect(c.chamadas).toEqual([{ nome: "push_limpar_token_invalido", args: { p_user_id: ANA, p_token: TOKEN } }]);
    expect(c.escritasDiretas).toEqual([]);
  });

  it("tokens válidos não são removidos", async () => {
    const c = cenario([{ token: TOKEN, user_id: ANA, operation_id: OPERACAO }]);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [{ status: "ok" }] }) })));

    await c.push.send(ANA, { titulo: "Aviso", texto: "Texto", link: null });

    expect(c.chamadas).toEqual([]);
  });
});
