import { camposFaltantes, descreverFaltantes, EMAIL_SUPORTE, imageProblem, TERMOS_VERSAO, type AcaoPerfil } from "@muve/shared/dominio.ts";
import type { AutorizacaoDePush, EncerramentoDePush, RegistroDePush } from "@muve/shared/contratos.ts";
import { calcularComprovanteBase64Url, ComprovanteInvalido } from "@muve/shared/pushComprovante.ts";
import type { Account, CompletarPerfilInput, DeleteAccountInput, EmissaoDePushInput, ProfileChanges, RegistroDePushInput, RemocaoDePushInput, RevogacaoDePushInput, Role, SignupInput } from "../domain/account.ts";
import { AppError } from "../domain/errors.ts";
import type { Inbox, VinculoDePushGateway } from "./notifications.ts";
import { seguirApesarDe } from "./falhas.ts";

export interface AccountStore {
  documentExists(documento: string, exceptUserId?: string): Promise<boolean>;
  createProfile(userId: string, profile: { role: Role; nome: string }): Promise<void>;
  findAccount(userId: string): Promise<Account | null>;
  findEmail(userId: string): Promise<string | null>;
  updateProfile(userId: string, role: Role, changes: ProfileChanges & { fotoPerfilUrl?: string }): Promise<void>;
  resetPaymentCustomer(userId: string): Promise<void>;
}

export interface AuthGateway {
  signUp(email: string, password: string, termosVersao: string, redirectTo?: string, captchaToken?: string): Promise<{ userId: string } | { emailTaken: true }>;
  verifyPassword(email: string, password: string, captchaToken?: string): Promise<boolean>;
  hasPassword(userId: string): Promise<boolean>;
  deleteUser(userId: string): Promise<void>;
  recordTermsAcceptance(userId: string, termosVersao: string): Promise<void>;
}

export interface CnpjLookup {
  situacao(cnpj: string): Promise<"ATIVA" | "INATIVA" | "INEXISTENTE" | null>;
}

export type ImageBucket = "avatars" | "event-banners";

export interface ImageStore {
  upload(bucket: ImageBucket, ownerId: string, file: File): Promise<string>;
  copy(bucket: ImageBucket, url: string): Promise<string>;
  removeByUrl(bucket: ImageBucket, url: string): Promise<void>;
  removeAllOf(bucket: ImageBucket, ownerId: string): Promise<void>;
}

export interface AuthUser {
  id: string;
  email: string;
}

const emailEmUso = () => new AppError(409, "EMAIL_EM_USO", "Este e-mail já está vinculado a uma conta.");
const contaNaoEncontrada = () => new AppError(404, "CONTA_NAO_ENCONTRADA", "Conta não encontrada.");

export function assertProfileComplete(account: Account, acao: AcaoPerfil): void {
  const faltando = camposFaltantes(account, acao);
  if (faltando.length === 0) return;
  throw new AppError(409, "PERFIL_INCOMPLETO", `Complete seu perfil antes de continuar. Falta: ${descreverFaltantes(faltando)}.`);
}

export function createAccountService(deps: {
  store: AccountStore;
  auth: AuthGateway;
  images: ImageStore;
  hasOngoingHiring(userId: string): Promise<boolean>;
  inbox: Pick<Inbox, "markAllRead" | "add">;
  releaseAccount(user: AuthUser, role: Role): Promise<void>;
  reopenFailedPayouts(musicianId: string): Promise<number>;
  cnpj: CnpjLookup;
  devices?: VinculoDePushGateway;
}) {
  const { store, auth, images } = deps;
  const dispositivos = () => {
    if (!deps.devices) throw new AppError(503, "PUSH_INDISPONIVEL", "O registro de aparelhos não está disponível agora.");
    return deps.devices;
  };

  return {
    async signup(input: SignupInput, redirectTo?: string): Promise<void> {
      const created = await auth.signUp(input.email, input.password, TERMOS_VERSAO, redirectTo, input.captchaToken);
      if ("emailTaken" in created) throw emailEmUso();
      const { userId } = created;
      if (await store.findAccount(userId)) throw emailEmUso();

      try {
        await store.createProfile(userId, { role: input.role, nome: input.nome });
      } catch (error) {
        await auth.deleteUser(userId).catch((cleanupError) => {
          console.error("Falha ao desfazer cadastro incompleto", userId, cleanupError);
        });
        throw error;
      }
    },

    async completeProfile(user: AuthUser, input: CompletarPerfilInput): Promise<void> {
      if (await store.findAccount(user.id)) throw new AppError(409, "PERFIL_EXISTENTE", "Esta conta já tem um perfil.");
      await store.createProfile(user.id, { role: input.role, nome: input.nome });
      await auth.recordTermsAcceptance(user.id, TERMOS_VERSAO);
    },

    async emitirDispositivo(user: AuthUser, input: EmissaoDePushInput): Promise<AutorizacaoDePush> {
      return dispositivos().emitir(user.id, input);
    },

    async registrarDispositivo(user: AuthUser, input: RegistroDePushInput): Promise<RegistroDePush> {
      return dispositivos().registrar(user.id, input);
    },

    async removerDispositivo(user: AuthUser, input: RemocaoDePushInput): Promise<EncerramentoDePush> {
      if (input.operationId && input.comprovante) {
        return dispositivos().cancelar(user.id, { token: input.token, operationId: input.operationId, comprovante: input.comprovante });
      }
      return dispositivos().removerLegado(user.id, input.token);
    },

    async revogarDispositivo(input: RevogacaoDePushInput): Promise<EncerramentoDePush> {
      let comprovante: string;
      try {
        comprovante = calcularComprovanteBase64Url(input.token, input.operationId, input.segredo);
      } catch (error) {
        if (error instanceof ComprovanteInvalido) throw new AppError(400, "PUSH_DADOS_INVALIDOS", "Dados do aparelho inválidos.");
        throw error;
      }
      return dispositivos().revogar({ token: input.token, operationId: input.operationId, comprovante });
    },

    async markNotificationsRead(user: AuthUser): Promise<void> {
      await deps.inbox.markAllRead(user.id);
    },

    async getMe(user: AuthUser): Promise<Account & { email: string }> {
      const account = await store.findAccount(user.id);
      if (!account) throw contaNaoEncontrada();
      return { ...account, email: user.email };
    },

    async updateProfile(user: AuthUser, role: Role, changes: ProfileChanges, avatar: File | null, atual?: Account): Promise<Account & { email: string }> {
      const current = atual ?? (await store.findAccount(user.id));
      if (!current) throw contaNaoEncontrada();
      if (changes.documento === null && current.documento) {
        throw new AppError(400, "DOCUMENTO_NAO_REMOVIVEL", "O CPF/CNPJ identifica a conta e não pode ser apagado. Para corrigir, informe o documento certo.");
      }
      if ("chavePix" in changes && changes.chavePix === null && current.chavePix) {
        throw new AppError(400, "CHAVE_PIX_NAO_REMOVIVEL", "A chave Pix recebe os seus cachês e não pode ser apagada, só trocada por outra.");
      }
      if (changes.documento && changes.documento !== current.documento && (await store.documentExists(changes.documento, user.id))) {
        throw new AppError(409, "DOCUMENTO_EM_USO", "Este CPF/CNPJ já está vinculado a outra conta.");
      }
      if (changes.documento && changes.documento !== current.documento && changes.documento.length === 14) {
        const situacao = await deps.cnpj.situacao(changes.documento);
        if (situacao === "INEXISTENTE") throw new AppError(400, "CNPJ_INEXISTENTE", "Este CNPJ não foi encontrado na Receita Federal.");
        if (situacao === "INATIVA") throw new AppError(400, "CNPJ_INATIVO", "Este CNPJ não está ativo na Receita Federal.");
      }

      const confirmacao = "senhaAtual" in changes ? { senha: changes.senhaAtual, captchaToken: changes.captchaToken } : { senha: undefined, captchaToken: undefined };
      const trocaChavePix = "chavePix" in changes && Boolean(current.chavePix) && changes.chavePix !== undefined
        && (changes.chavePix !== current.chavePix || changes.chavePixTipo !== current.chavePixTipo);
      if (trocaChavePix && (await auth.hasPassword(user.id))) {
        if (!confirmacao.senha) throw new AppError(400, "SENHA_NECESSARIA", "Para trocar a chave Pix, confirme a senha da conta.");
        if (!(await auth.verifyPassword(user.email, confirmacao.senha, confirmacao.captchaToken))) throw new AppError(400, "SENHA_INCORRETA", "A senha não confere. A chave Pix não foi alterada.");
      }

      if (role === "CONTRACTOR" && (changes.nome !== current.nome || (changes.documento && changes.documento !== current.documento))) {
        await store.resetPaymentCustomer(user.id);
      }
      const avisarTrocaDaChave = async () => {
        if (!trocaChavePix) return;
        const reabertos = await deps.reopenFailedPayouts(user.id).catch(seguirApesarDe("Repasses que falharam não foram reabertos", 0));
        const repetir = reabertos > 0 ? " Os repasses que tinham falhado serão enviados de novo para ela." : "";
        await deps.inbox.add({ userId: user.id, titulo: "Chave Pix alterada", texto: `Os próximos repasses vão para a chave nova.${repetir} Se não foi você, escreva para ${EMAIL_SUPORTE}.`, link: "/account/edit" }).catch(seguirApesarDe("Aviso de troca da chave Pix não enviado", undefined));
      };
      if (!avatar) {
        await store.updateProfile(user.id, role, changes);
        await avisarTrocaDaChave();
        return this.getMe(user);
      }
      const problem = imageProblem(avatar);
      if (problem) throw new AppError(400, "IMAGEM_INVALIDA", problem);
      const fotoPerfilUrl = await images.upload("avatars", user.id, avatar);
      try {
        await store.updateProfile(user.id, role, { ...changes, fotoPerfilUrl });
      } catch (error) {
        await images.removeByUrl("avatars", fotoPerfilUrl).catch(seguirApesarDe("Foto nova não removida depois da falha", undefined));
        throw error;
      }
      if (current.fotoPerfilUrl) await images.removeByUrl("avatars", current.fotoPerfilUrl).catch(seguirApesarDe("Foto antiga não removida", undefined));
      await avisarTrocaDaChave();
      return this.getMe(user);
    },

    async deleteAccount(user: AuthUser, input: DeleteAccountInput): Promise<void> {
      const naoConfere = new AppError(400, "CREDENCIAIS_NAO_CONFEREM", "E-mail ou senha não correspondem à conta atual.");
      if (input.email !== user.email.toLowerCase()) throw naoConfere;
      if ((await auth.hasPassword(user.id)) && !(await auth.verifyPassword(user.email, input.password, input.captchaToken))) throw naoConfere;

      if (await deps.hasOngoingHiring(user.id)) {
        throw new AppError(
          409,
          "CONTRATACAO_EM_ANDAMENTO",
          "Você tem uma contratação em andamento ou valores ainda não repassados ou devolvidos. Aguarde a conclusão antes de excluir a conta.",
        );
      }

      const account = await store.findAccount(user.id);
      if (account) await deps.releaseAccount(user, account.role);
      await auth.deleteUser(user.id);
      await images.removeAllOf("avatars", user.id).catch(seguirApesarDe("Fotos da conta excluída não removidas", undefined));
      await images.removeAllOf("event-banners", user.id).catch(seguirApesarDe("Capas da conta excluída não removidas", undefined));
    },
  };
}

export type AccountService = ReturnType<typeof createAccountService>;
