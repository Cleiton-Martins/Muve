import type { SupabaseClient } from "@supabase/supabase-js";
import type { AutorizacaoDePush, EncerramentoDePush, RegistroDePush } from "@muve/shared/contratos.ts";
import { base64UrlDe32Bytes, bytesParaHex } from "@muve/shared/pushComprovante.ts";
import { AppError } from "../domain/errors.ts";
import type { OperacaoDePush, PushGateway, VinculoDePushGateway } from "../services/notifications.ts";

interface ExpoTicket {
  status: "ok" | "error";
  details?: { error?: string };
}

export const DISPOSITIVO_EM_OUTRA_CONTA = "DISPOSITIVO_EM_OUTRA_CONTA";

export type IntencaoDePush = "CREATE" | "ATTACH_LEGACY" | "REPLACE";

type ErroDoBanco = { message?: string; code?: string } | null;

const estadoAlterado = () => new AppError(409, "PUSH_ESTADO_ALTERADO", "O vínculo deste aparelho mudou. Tente novamente.");
const dadosInvalidos = () => new AppError(400, "PUSH_DADOS_INVALIDOS", "Dados do aparelho inválidos.");
const indisponivel = () => new AppError(503, "PUSH_INDISPONIVEL", "O registro de aparelhos não está disponível agora.");
const muitosRegistros = () => new AppError(429, "PUSH_LIMITE", "Muitos registros de aparelho em pouco tempo.");

const ERROS_DO_BANCO: Record<string, () => AppError> = {
  DISPOSITIVO_EM_OUTRA_CONTA: () =>
    new AppError(409, DISPOSITIVO_EM_OUTRA_CONTA, "Este aparelho ainda está vinculado às notificações de outra conta. Saia dela neste aparelho para receber avisos aqui."),
  PUSH_INTENCAO_INCOMPATIVEL: estadoAlterado,
  PUSH_ESTADO_DIVERGENTE: estadoAlterado,
  PUSH_GERACAO_SUBSTITUIDA: () => new AppError(409, "PUSH_GERACAO_SUBSTITUIDA", "Este registro foi substituído por um mais recente."),
  PUSH_OPERACAO_CONFLITANTE: () => new AppError(409, "PUSH_OPERACAO_CONFLITANTE", "Esta operação já foi usada com outros dados."),
  PUSH_AUTORIZACAO_NAO_CONFERE: () => new AppError(409, "PUSH_AUTORIZACAO_NAO_CONFERE", "Os dados não conferem com a autorização emitida."),
  PUSH_AUTORIZACAO_INEXISTENTE: () => new AppError(409, "PUSH_AUTORIZACAO_INEXISTENTE", "Autorização não encontrada."),
  PUSH_AUTORIZACAO_TERMINAL: () => new AppError(409, "PUSH_AUTORIZACAO_TERMINAL", "Esta autorização já foi encerrada."),
  PUSH_AUTORIZACAO_EXPIRADA: () => new AppError(409, "PUSH_AUTORIZACAO_EXPIRADA", "Esta autorização venceu."),
  PUSH_CONTA_INEXISTENTE: () => new AppError(409, "PUSH_CONTA_INEXISTENTE", "Conta não encontrada."),
  PUSH_FREQUENCIA_EXCEDIDA: muitosRegistros,
  PUSH_PENDENTES_EXCEDIDAS: muitosRegistros,
  PUSH_LIMITE_DA_CONTA: () => new AppError(429, "PUSH_LIMITE", "Esta conta atingiu o limite de registros de aparelho."),
  PUSH_CAPACIDADE_ESGOTADA: indisponivel,
  PUSH_PARAMETROS_AUSENTES: indisponivel,
  PUSH_ISOLAMENTO_NAO_SUPORTADO: indisponivel,
  PUSH_TOKEN_INVALIDO: dadosInvalidos,
  PUSH_COMPROVANTE_INVALIDO: dadosInvalidos,
  PUSH_PARAMETRO_INVALIDO: dadosInvalidos,
  PUSH_INTENCAO_INVALIDA: dadosInvalidos,
};

const codigoDoBanco = (error: ErroDoBanco) => (error?.message && Object.prototype.hasOwnProperty.call(ERROS_DO_BANCO, error.message) ? error.message : null);

function falha(error: ErroDoBanco): never {
  const codigo = codigoDoBanco(error);
  if (codigo) throw ERROS_DO_BANCO[codigo]();
  throw error;
}

const bytea = (base64Url: string) => `\\x${bytesParaHex(base64UrlDe32Bytes(base64Url, "comprovante"))}`;

function primeiraLinha<T>(data: unknown): T {
  const linha = Array.isArray(data) ? data[0] : data;
  if (!linha) throw new Error("Função de push não devolveu resultado");
  return linha as T;
}

export function createExpoPush(admin: SupabaseClient): PushGateway & VinculoDePushGateway {
  async function tokensOf(userId: string): Promise<string[]> {
    const { data, error } = await admin.from("push_tokens").select("token").eq("user_id", userId);
    if (error) throw error;
    return data.map((row) => row.token);
  }

  async function intencaoPara(userId: string, token: string): Promise<IntencaoDePush> {
    const { data, error } = await admin.from("push_tokens").select("user_id, operation_id").eq("token", token).maybeSingle();
    if (error) throw error;
    if (!data || data.user_id !== userId) return "CREATE";
    return data.operation_id ? "REPLACE" : "ATTACH_LEGACY";
  }

  async function chamarEmissao(userId: string, operacao: OperacaoDePush) {
    return admin.rpc("push_emitir_autorizacao", {
      p_user_id: userId,
      p_operation_id: operacao.operationId,
      p_token: operacao.token,
      p_comprovante: bytea(operacao.comprovante),
      p_intencao: await intencaoPara(userId, operacao.token),
    });
  }

  async function emitirComEstadoAtual(userId: string, operacao: OperacaoDePush) {
    const resposta = await chamarEmissao(userId, operacao);
    return codigoDoBanco(resposta.error) === "PUSH_INTENCAO_INCOMPATIVEL" ? chamarEmissao(userId, operacao) : resposta;
  }

  return {
    async emitir(userId, operacao) {
      let resposta = await emitirComEstadoAtual(userId, operacao);
      if (codigoDoBanco(resposta.error) === "PUSH_PENDENTES_EXCEDIDAS") {
        const limpeza = await admin.rpc("push_encerrar_expiradas", { p_limite: 100 });
        if (limpeza.error) falha(limpeza.error);
        resposta = await emitirComEstadoAtual(userId, operacao);
      }
      if (resposta.error) falha(resposta.error);
      const linha = primeiraLinha<{
        operation_id: string;
        target_vinculo_id: string;
        expected_state: AutorizacaoDePush["estadoEsperado"];
        estado: AutorizacaoDePush["estado"];
        expira_em: string;
        resultado: AutorizacaoDePush["resultado"];
      }>(resposta.data);
      return {
        operationId: linha.operation_id,
        vinculoId: linha.target_vinculo_id,
        estadoEsperado: linha.expected_state,
        estado: linha.estado,
        expiraEm: linha.expira_em,
        resultado: linha.resultado,
      };
    },

    async registrar(userId, operacao) {
      const { data, error } = await admin.rpc("push_registrar_token", {
        p_user_id: userId,
        p_operation_id: operacao.operationId,
        p_token: operacao.token,
        p_comprovante: bytea(operacao.comprovante),
        p_target_vinculo_id: operacao.vinculoId,
      });
      if (error) falha(error);
      const linha = primeiraLinha<{ vinculo_id: string; resultado: RegistroDePush["resultado"] }>(data);
      return { vinculoId: linha.vinculo_id, resultado: linha.resultado };
    },

    async cancelar(userId, operacao) {
      const { data, error } = await admin.rpc("push_cancelar_operacao", {
        p_user_id: userId,
        p_operation_id: operacao.operationId,
        p_token: operacao.token,
        p_comprovante: bytea(operacao.comprovante),
      });
      if (error) falha(error);
      return primeiraLinha<EncerramentoDePush>(data);
    },

    async removerLegado(userId, token) {
      const { data, error } = await admin.rpc("push_remover_vinculo_legado", { p_user_id: userId, p_token: token });
      if (error) falha(error);
      return { estado: null, resultado: data as EncerramentoDePush["resultado"] };
    },

    async revogar(operacao) {
      const { data, error } = await admin.rpc("push_revogar_por_segredo", {
        p_operation_id: operacao.operationId,
        p_token: operacao.token,
        p_comprovante: bytea(operacao.comprovante),
      });
      if (error) falha(error);
      return primeiraLinha<EncerramentoDePush>(data);
    },

    async send(userId, message) {
      const tokens = await tokensOf(userId);
      if (tokens.length === 0) return;
      const response = await fetch("https://exp.host/--/api/v2/push/send", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(tokens.map((to) => ({ to, title: message.titulo, body: message.texto, data: { link: message.link }, sound: "default" }))),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`Expo push respondeu ${response.status}`);
      const { data } = (await response.json()) as { data: ExpoTicket[] };
      const invalid = tokens.filter((_, i) => data[i]?.details?.error === "DeviceNotRegistered");
      for (const token of invalid) {
        const { error } = await admin.rpc("push_limpar_token_invalido", { p_user_id: userId, p_token: token });
        if (error) throw error;
      }
    },
  };
}
