import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { confirmacaoConfere, fraseDeConfirmacao, validarExecucao } from "./contas-demo-seguranca.mjs";

const unsplash = (id) => `https://images.unsplash.com/photo-${id}?w=400&h=400&fit=crop`;

const contas = [
  { email: "teste@teste.com", role: "MUSICIAN", perfil: { nome_completo: "Músico Teste", documento: "52998224725", telefone: "45999990001", foto_perfil_url: unsplash("1510915361894-db8b60106cb1"), uf: "PR", cidade: "Cascavel", estilos_musicais: ["Rock", "MPB", "Sertanejo"], bio: "Conta de demonstração. Voz e violão, repertório variado.", chave_pix_tipo: "EMAIL", chave_pix: "cliente-a00001@pix.bcb.gov.br" } },
  { email: "contratante@teste.com", role: "CONTRACTOR", perfil: { nome_fantasia: "Bar Teste", documento: "11222333000181", telefone: "45322210001", foto_perfil_url: unsplash("1514933651103-005eec06c04b"), uf: "PR", cidade: "Cascavel" } },
];

export const QUANTIDADE_DE_CONTAS = contas.length;

export async function recriarContas(admin, senha) {
  const { data, error: falhaNaListagem } = await admin.auth.admin.listUsers({ perPage: 200 });
  if (falhaNaListagem) throw falhaNaListagem;
  for (const conta of contas) {
    for (const u of data.users.filter((u) => u.email === conta.email)) {
      const { error: falhaNaRemocao } = await admin.auth.admin.deleteUser(u.id);
      if (falhaNaRemocao) throw falhaNaRemocao;
    }
    const { data: created, error } = await admin.auth.admin.createUser({ email: conta.email, password: senha, email_confirm: true });
    if (error) throw error;
    await admin.from("profiles").insert({ id: created.user.id, role: conta.role }).throwOnError();
    await admin.from(conta.role === "MUSICIAN" ? "musician_profiles" : "contractor_profiles").insert({ user_id: created.user.id, ...conta.perfil }).throwOnError();
    console.log(`${conta.role === "MUSICIAN" ? "Músico" : "Contratante"} de demonstração recriado.`);
  }
}

export async function executar({ env, terminalInterativo, perguntar, criarCliente, log, erro }) {
  const execucao = validarExecucao(env, { terminalInterativo });
  if (!execucao.permitida) {
    for (const problema of execucao.problemas) erro(problema);
    erro("Nada foi alterado.");
    return 1;
  }
  log(`Este script APAGA e recria ${QUANTIDADE_DE_CONTAS} contas de demonstração no Supabase em ${execucao.destino}.`);
  const resposta = await perguntar(`Para continuar, digite exatamente: ${fraseDeConfirmacao(execucao.destino, QUANTIDADE_DE_CONTAS)}\n> `);
  if (!confirmacaoConfere(resposta, execucao.destino, QUANTIDADE_DE_CONTAS)) {
    erro("A confirmação não conferiu. Nada foi alterado.");
    return 1;
  }
  const admin = await criarCliente(execucao.url, execucao.chave);
  await recriarContas(admin, execucao.senha);
  log("Contas recriadas. A senha é a que você definiu na variável de ambiente; ela não é exibida.");
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const leitura = createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.exitCode = await executar({
      env: process.env,
      terminalInterativo: process.stdin.isTTY === true && process.stdout.isTTY === true,
      perguntar: (pergunta) => leitura.question(pergunta),
      criarCliente: async (url, chave) => {
        const { createClient } = await import("@supabase/supabase-js");
        return createClient(url, chave, { auth: { persistSession: false } });
      },
      log: console.log,
      erro: console.error,
    });
  } finally {
    leitura.close();
  }
}
