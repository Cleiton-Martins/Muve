const HOSTS_LOCAIS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export const VARIAVEIS = {
  ambiente: "MUVE_DEMO_AMBIENTE",
  url: "MUVE_DEMO_SUPABASE_URL",
  chave: "MUVE_DEMO_SERVICE_ROLE_KEY",
  senha: "MUVE_DEMO_SENHA",
};

export const SENHA_TAMANHO_MINIMO = 12;

const preenchida = (valor) => typeof valor === "string" && valor.trim() !== "";

function destinoLocal(valor) {
  if (!preenchida(valor)) return null;
  let url;
  try {
    url = new URL(valor);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (!HOSTS_LOCAIS.has(url.hostname)) return null;
  return { url: url.origin, destino: url.host };
}

export function validarExecucao(env, { terminalInterativo }) {
  const problemas = [];
  if (env.NODE_ENV === "production") problemas.push("NODE_ENV=production: este script nunca roda em produção.");
  if (env[VARIAVEIS.ambiente] !== "local") problemas.push(`Defina ${VARIAVEIS.ambiente}=local para declarar que o destino é um Supabase local.`);
  const local = destinoLocal(env[VARIAVEIS.url]);
  if (!local) problemas.push(`${VARIAVEIS.url} precisa ser um endereço http(s) de localhost, 127.0.0.1 ou [::1], sem credenciais.`);
  if (!preenchida(env[VARIAVEIS.chave])) problemas.push(`Defina ${VARIAVEIS.chave} com a chave de serviço do Supabase local.`);
  const senha = env[VARIAVEIS.senha];
  if (!preenchida(senha) || senha.length < SENHA_TAMANHO_MINIMO) {
    problemas.push(`Defina ${VARIAVEIS.senha} com pelo menos ${SENHA_TAMANHO_MINIMO} caracteres. O script não tem senha padrão.`);
  }
  if (terminalInterativo !== true) problemas.push("Execute em um terminal interativo: a confirmação é digitada por uma pessoa.");
  if (problemas.length > 0 || !local) return { permitida: false, problemas };
  return { permitida: true, url: local.url, destino: local.destino, chave: env[VARIAVEIS.chave], senha };
}

export function fraseDeConfirmacao(destino, quantidadeDeContas) {
  return `apagar e recriar ${quantidadeDeContas} contas em ${destino}`;
}

export function confirmacaoConfere(resposta, destino, quantidadeDeContas) {
  return typeof resposta === "string" && resposta.trim() === fraseDeConfirmacao(destino, quantidadeDeContas);
}
