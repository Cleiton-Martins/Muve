import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { confirmacaoConfere, fraseDeConfirmacao, SENHA_TAMANHO_MINIMO, validarExecucao, VARIAVEIS } from "./contas-demo-seguranca.mjs";

const criarClienteDoSupabase = vi.hoisted(() => vi.fn());
vi.mock("@supabase/supabase-js", () => ({ createClient: criarClienteDoSupabase }));

const SENHA_DE_TESTE = "valor-ficticio-de-teste";
const CHAVE_DE_TESTE = "chave-ficticia-de-teste";
const ambienteValido = (extra = {}) => ({
  [VARIAVEIS.ambiente]: "local",
  [VARIAVEIS.url]: "http://127.0.0.1:54321",
  [VARIAVEIS.chave]: CHAVE_DE_TESTE,
  [VARIAVEIS.senha]: SENHA_DE_TESTE,
  ...extra,
});
const interativo = { terminalInterativo: true };

function clienteSimulado() {
  const chamadas = { removidos: [], criados: [], inseridos: [] };
  const admin = {
    auth: {
      admin: {
        listUsers: vi.fn(async () => ({ data: { users: [] }, error: null })),
        deleteUser: vi.fn(async (id) => {
          chamadas.removidos.push(id);
          return { error: null };
        }),
        createUser: vi.fn(async (dados) => {
          chamadas.criados.push(dados);
          return { data: { user: { id: `u${chamadas.criados.length}` } }, error: null };
        }),
      },
    },
    from: (tabela) => ({
      insert: (linha) => ({
        throwOnError: async () => {
          chamadas.inseridos.push({ tabela, linha });
        },
      }),
    }),
  };
  return { admin, chamadas };
}

function execucao(env, { terminalInterativo = true, resposta } = {}) {
  const { admin, chamadas } = clienteSimulado();
  const saida = [];
  const perguntar = vi.fn(async (pergunta) => {
    saida.push(pergunta);
    return typeof resposta === "function" ? resposta(pergunta) : resposta;
  });
  const criarCliente = vi.fn(async () => admin);
  const dependencias = { env, terminalInterativo, perguntar, criarCliente, log: (texto) => saida.push(texto), erro: (texto) => saida.push(texto) };
  return { dependencias, perguntar, criarCliente, chamadas, saida, admin };
}

describe("validação da execução", () => {
  it("aceita apenas o conjunto completo: ambiente local declarado, destino local, chave, senha e terminal", () => {
    expect(validarExecucao(ambienteValido(), interativo)).toEqual({
      permitida: true,
      url: "http://127.0.0.1:54321",
      destino: "127.0.0.1:54321",
      chave: CHAVE_DE_TESTE,
      senha: SENHA_DE_TESTE,
    });
  });

  it.each(["http://localhost:54321", "http://[::1]:54321", "https://localhost:8443/"])("aceita o endereço local %s", (url) => {
    expect(validarExecucao(ambienteValido({ [VARIAVEIS.url]: url }), interativo).permitida).toBe(true);
  });

  it.each([
    "https://projeto.supabase.co",
    "http://192.168.0.10:54321",
    "http://localhost.exemplo.test:54321",
    "http://127.0.0.1.exemplo.test",
    "http://usuario:segredo@127.0.0.1:54321",
    "postgresql://127.0.0.1:54322/postgres",
    "127.0.0.1:54321",
    "",
    undefined,
  ])("recusa o destino %s", (url) => {
    const resultado = validarExecucao(ambienteValido({ [VARIAVEIS.url]: url }), interativo);
    expect(resultado.permitida).toBe(false);
    expect(resultado.problemas.join(" ")).toContain(VARIAVEIS.url);
  });

  it("recusa sem a declaração explícita de ambiente local", () => {
    for (const valor of [undefined, "", "producao", "LOCAL", "staging"]) {
      expect(validarExecucao(ambienteValido({ [VARIAVEIS.ambiente]: valor }), interativo).permitida).toBe(false);
    }
  });

  it("recusa em produção, mesmo com todo o resto válido", () => {
    const resultado = validarExecucao(ambienteValido({ NODE_ENV: "production" }), interativo);
    expect(resultado.permitida).toBe(false);
    expect(resultado.problemas.join(" ")).toContain("produção");
  });

  it("não tem senha padrão: sem a variável, vazia ou curta, recusa", () => {
    for (const senha of [undefined, "", "   ", "x".repeat(SENHA_TAMANHO_MINIMO - 1)]) {
      expect(validarExecucao(ambienteValido({ [VARIAVEIS.senha]: senha }), interativo).permitida).toBe(false);
    }
  });

  it("recusa sem a chave de serviço e sem terminal interativo", () => {
    expect(validarExecucao(ambienteValido({ [VARIAVEIS.chave]: undefined }), interativo).permitida).toBe(false);
    expect(validarExecucao(ambienteValido(), { terminalInterativo: false }).permitida).toBe(false);
    expect(validarExecucao(ambienteValido(), {}).permitida).toBe(false);
  });

  it("não usa as variáveis genéricas do servidor como destino", () => {
    const env = { SUPABASE_URL: "http://127.0.0.1:54321", SUPABASE_SERVICE_ROLE_KEY: CHAVE_DE_TESTE, [VARIAVEIS.ambiente]: "local", [VARIAVEIS.senha]: SENHA_DE_TESTE };
    expect(validarExecucao(env, interativo).permitida).toBe(false);
  });

  it("as mensagens de recusa não repetem senha, chave nem endereço informados", () => {
    const env = ambienteValido({ NODE_ENV: "production", [VARIAVEIS.url]: "https://projeto-real.supabase.co", [VARIAVEIS.senha]: "curta-123" });
    const texto = validarExecucao(env, { terminalInterativo: false }).problemas.join("\n");
    expect(texto).not.toContain("curta-123");
    expect(texto).not.toContain(CHAVE_DE_TESTE);
    expect(texto).not.toContain("projeto-real");
  });
});

describe("confirmação", () => {
  it("a frase cita a operação, a quantidade de contas e o destino", () => {
    expect(fraseDeConfirmacao("127.0.0.1:54321", 2)).toBe("apagar e recriar 2 contas em 127.0.0.1:54321");
  });

  it("só confere com a frase exata do destino e da quantidade em questão", () => {
    expect(confirmacaoConfere("  apagar e recriar 2 contas em 127.0.0.1:54321 ", "127.0.0.1:54321", 2)).toBe(true);
    for (const resposta of ["", "s", "sim", "y", "yes", "apagar e recriar 2 contas em localhost:54321", "apagar e recriar 3 contas em 127.0.0.1:54321", "APAGAR E RECRIAR 2 CONTAS EM 127.0.0.1:54321", undefined, null]) {
      expect(confirmacaoConfere(resposta, "127.0.0.1:54321", 2)).toBe(false);
    }
  });
});

describe("script de contas de demonstração", () => {
  const codigo = readFileSync(new URL("./contas-demo.mjs", import.meta.url), "utf8");

  it("importar o módulo não cria cliente, não pergunta nada e não executa", async () => {
    const leituraDoEnv = vi.spyOn(process, "loadEnvFile");
    const modulo = await import("./contas-demo.mjs");

    expect(criarClienteDoSupabase).not.toHaveBeenCalled();
    expect(leituraDoEnv).not.toHaveBeenCalled();
    expect(modulo.QUANTIDADE_DE_CONTAS).toBe(2);
    leituraDoEnv.mockRestore();
  });

  it("o código não tem senha literal, não lê o .env do Backend e não importa o cliente fora da execução", () => {
    expect(codigo).not.toMatch(/env-do-backend|lerEnvDoBackend|loadEnvFile|readFileSync/);
    expect(codigo).not.toMatch(/\b(PASSWORD|SENHA|senha|password)\s*=\s*["'`]/);
    expect(codigo).not.toMatch(/password:\s*["'`]/);
    expect(codigo).not.toMatch(/^import .*@supabase\/supabase-js/m);
    expect(codigo.match(/password:/g)).toEqual(["password:"]);
    expect(codigo).toContain("password: senha,");
  });

  it("recusa antes de perguntar ou criar cliente quando a validação falha", async () => {
    const { executar } = await import("./contas-demo.mjs");
    const c = execucao(ambienteValido({ [VARIAVEIS.url]: "https://projeto.supabase.co" }));

    await expect(executar(c.dependencias)).resolves.toBe(1);

    expect(c.perguntar).not.toHaveBeenCalled();
    expect(c.criarCliente).not.toHaveBeenCalled();
    expect(c.saida.join("\n")).toContain("Nada foi alterado.");
  });

  it("confirmação errada não cria cliente nem toca em conta", async () => {
    const { executar } = await import("./contas-demo.mjs");
    const c = execucao(ambienteValido(), { resposta: "sim" });

    await expect(executar(c.dependencias)).resolves.toBe(1);

    expect(c.perguntar).toHaveBeenCalledOnce();
    expect(c.criarCliente).not.toHaveBeenCalled();
    expect(c.chamadas.criados).toEqual([]);
  });

  it("com tudo válido e a frase exata, cria o cliente só depois da confirmação e nunca exibe a senha", async () => {
    const { executar } = await import("./contas-demo.mjs");
    const frase = fraseDeConfirmacao("127.0.0.1:54321", 2);
    const console_ = vi.spyOn(console, "log").mockImplementation(() => {});
    const c = execucao(ambienteValido(), {
      resposta: (pergunta) => {
        expect(pergunta).toContain(frase);
        expect(c.criarCliente).not.toHaveBeenCalled();
        return frase;
      },
    });

    await expect(executar(c.dependencias)).resolves.toBe(0);

    expect(c.criarCliente).toHaveBeenCalledExactlyOnceWith("http://127.0.0.1:54321", CHAVE_DE_TESTE);
    expect(c.chamadas.criados).toHaveLength(2);
    expect(c.chamadas.criados.every((conta) => conta.password === SENHA_DE_TESTE && conta.email_confirm === true)).toBe(true);
    expect(c.chamadas.inseridos.map((item) => item.tabela)).toEqual(["profiles", "musician_profiles", "profiles", "contractor_profiles"]);
    const exibido = [...c.saida, ...console_.mock.calls.flat().map(String)].join("\n");
    expect(exibido).not.toContain(SENHA_DE_TESTE);
    expect(exibido).not.toContain(CHAVE_DE_TESTE);
    expect(exibido).not.toContain("@");
    console_.mockRestore();
  });
});
