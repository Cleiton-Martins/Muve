import { linkComProtocolo, onlyDigits, REDES_SOCIAIS, type RedeSocial, type RedesSociais } from "@muve/shared/dominio.ts";

export interface PerfilAtual {
  role: "MUSICIAN" | "CONTRACTOR";
  nome: string;
  documento: string | null;
  telefone: string | null;
  uf: string | null;
  cidade: string | null;
  bio?: string | null;
  estilosMusicais?: readonly string[] | null;
  chavePixTipo?: string | null;
  chavePix?: string | null;
  portfolioUrl?: string | null;
  redesSociais?: RedesSociais;
}

export interface FormularioDoPerfil {
  nome: string;
  documento: string;
  telefone: string;
  uf: string;
  cidade: string;
  bio: string;
  chavePixTipo: string;
  chavePix: string;
  portfolioUrl: string;
  redes: Record<RedeSocial, string>;
  estilos: readonly string[];
}

export interface AlteracoesDoPerfil {
  nome: string;
  documento?: string | null;
  telefone?: string | null;
  uf?: string | null;
  cidade?: string | null;
  bio?: string | null;
  estilosMusicais?: string[] | null;
  chavePixTipo?: string | null;
  chavePix?: string | null;
  portfolioUrl?: string | null;
  redesSociais?: Record<RedeSocial, string>;
}

const campoDeTexto = (digitado: string, atual: string | null | undefined): string | null | undefined => {
  const novo = digitado.trim();
  const antigo = atual ?? "";
  if (novo === antigo) return undefined;
  return novo || null;
};

const mesmaLista = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((item) => b.includes(item));

export const CAMPOS_NAO_REMOVIVEIS = {
  documento: "O CPF/CNPJ identifica a conta e não pode ser apagado. Para corrigir, informe o documento certo.",
  chavePix: "A chave Pix recebe os seus cachês e não pode ser apagada, só trocada por outra.",
} as const;

export function limpezaProibida(me: PerfilAtual, form: FormularioDoPerfil): string | null {
  if (me.documento && !onlyDigits(form.documento)) return CAMPOS_NAO_REMOVIVEIS.documento;
  if (me.role === "MUSICIAN" && me.chavePix && !form.chavePix.trim()) return CAMPOS_NAO_REMOVIVEIS.chavePix;
  return null;
}

export function montarAlteracoesDoPerfil(me: PerfilAtual, form: FormularioDoPerfil): AlteracoesDoPerfil {
  const alteracoes: AlteracoesDoPerfil = { nome: form.nome.trim() };
  const documento = campoDeTexto(onlyDigits(form.documento), me.documento);
  if (documento !== undefined) alteracoes.documento = documento;
  const telefone = campoDeTexto(onlyDigits(form.telefone), me.telefone);
  if (telefone !== undefined) alteracoes.telefone = telefone;

  const uf = campoDeTexto(form.uf, me.uf);
  const cidade = campoDeTexto(form.cidade, me.cidade);
  if (uf !== undefined || cidade !== undefined) {
    if (!form.uf.trim() || !form.cidade.trim()) {
      alteracoes.uf = null;
      alteracoes.cidade = null;
    } else {
      alteracoes.uf = form.uf.trim();
      alteracoes.cidade = form.cidade.trim();
    }
  }

  if (me.role !== "MUSICIAN") return alteracoes;

  if (!mesmaLista(form.estilos, me.estilosMusicais ?? [])) alteracoes.estilosMusicais = form.estilos.length ? [...form.estilos] : null;
  const bio = campoDeTexto(form.bio, me.bio);
  if (bio !== undefined) alteracoes.bio = bio;
  const site = campoDeTexto(linkComProtocolo(form.portfolioUrl), me.portfolioUrl);
  if (site !== undefined) alteracoes.portfolioUrl = site;

  const redesAtuais = me.redesSociais ?? {};
  if (REDES_SOCIAIS.some((rede) => form.redes[rede].trim() !== (redesAtuais[rede] ?? ""))) {
    alteracoes.redesSociais = Object.fromEntries(REDES_SOCIAIS.map((rede) => [rede, form.redes[rede].trim()])) as Record<RedeSocial, string>;
  }

  const chave = form.chavePix.trim();
  if (chave !== (me.chavePix ?? "") || (chave && form.chavePixTipo !== (me.chavePixTipo ?? ""))) {
    alteracoes.chavePix = chave || null;
    alteracoes.chavePixTipo = chave ? form.chavePixTipo : null;
  }
  return alteracoes;
}
