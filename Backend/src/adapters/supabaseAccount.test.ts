import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAccountStore } from "./supabase.ts";

type Linha = Record<string, unknown>;

type ErroDoBanco = { code: string; message: string; details?: string };

const chaveDuplicada = (tabela: string, coluna: string, valor: unknown): ErroDoBanco => ({
  code: "23505",
  message: `duplicate key value violates unique constraint "${tabela}_pkey"`,
  details: `Key (${coluna})=(${String(valor)}) already exists.`,
});

function bancoFalso(opcoes: { falharDetalhe?: () => boolean; erroDoDetalhe?: () => ErroDoBanco | undefined } = {}) {
  const tabelas: Record<string, Linha[]> = { profiles: [], musician_profiles: [], contractor_profiles: [] };
  const chamadas: string[] = [];
  const detalhePor = (role: string) => (role === "MUSICIAN" ? "musician_profiles" : "contractor_profiles");

  const from = (tabela: string) => ({
    insert: async (linha: Linha) => {
      chamadas.push(`insert ${tabela}`);
      if (tabela !== "profiles" && opcoes.falharDetalhe?.()) return { error: { code: "XX000", message: "falha simulada no banco" } };
      const erroDoDetalhe = tabela !== "profiles" ? opcoes.erroDoDetalhe?.() : undefined;
      if (erroDoDetalhe) return { error: erroDoDetalhe };
      const chave = tabela === "profiles" ? "id" : "user_id";
      if (tabelas[tabela].some((l) => l[chave] === linha[chave])) return { error: chaveDuplicada(tabela, chave, linha[chave]) };
      tabelas[tabela].push(linha);
      return { error: null };
    },
    delete: () => ({
      eq: async (coluna: string, valor: unknown) => {
        chamadas.push(`delete ${tabela}`);
        tabelas[tabela] = tabelas[tabela].filter((l) => l[coluna] !== valor);
        return { error: null };
      },
    }),
    select: () => ({
      eq: (coluna: string, valor: unknown) => ({
        maybeSingle: async () => {
          chamadas.push(`select ${tabela}`);
          const linha = tabelas[tabela].find((l) => l[coluna] === valor);
          if (!linha) return { data: null, error: null };
          if (tabela !== "profiles") return { data: linha, error: null };
          const detalhe = tabelas[detalhePor(String(linha.role))].find((l) => l.user_id === linha.id);
          return { data: { role: linha.role, musician_profiles: linha.role === "MUSICIAN" && detalhe ? detalhe : null, contractor_profiles: linha.role === "CONTRACTOR" && detalhe ? detalhe : null }, error: null };
        },
      }),
    }),
  });
  return { admin: { from } as unknown as SupabaseClient, tabelas, chamadas };
}

describe("criação do perfil em duas tabelas", () => {
  it("quando a tabela de detalhe falha, a linha de profiles é preservada, a falha fica no log e a nova tentativa conclui o cadastro", async () => {
    let falhar = true;
    const banco = bancoFalso({ falharDetalhe: () => falhar });
    const store = createAccountStore(banco.admin);
    const erros: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void erros.push(args);

    await expect(store.createProfile("u1", { role: "MUSICIAN", nome: "Ana" })).rejects.toMatchObject({ message: "falha simulada no banco" });

    console.error = original;
    expect(banco.tabelas.profiles).toEqual([{ id: "u1", role: "MUSICIAN" }]);
    expect(banco.chamadas).not.toContain("delete profiles");
    expect(erros[0]?.[0]).toContain("Perfil incompleto");

    falhar = false;
    await expect(store.createProfile("u1", { role: "MUSICIAN", nome: "Ana" })).resolves.toBeUndefined();
    expect(banco.tabelas.profiles).toHaveLength(1);
    expect(banco.tabelas.musician_profiles).toEqual([{ user_id: "u1", nome_completo: "Ana" }]);
  });

  it("perfil já criado pela metade é completado na nova tentativa, só com o mesmo papel", async () => {
    const banco = bancoFalso();
    banco.tabelas.profiles.push({ id: "u2", role: "CONTRACTOR" });
    const store = createAccountStore(banco.admin);

    await expect(store.createProfile("u2", { role: "MUSICIAN", nome: "Outro papel" })).rejects.toMatchObject({ code: "PERFIL_EXISTENTE" });
    await expect(store.createProfile("u2", { role: "CONTRACTOR", nome: "Bar" })).resolves.toBeUndefined();
    expect(banco.tabelas.contractor_profiles).toEqual([{ user_id: "u2", nome_fantasia: "Bar" }]);
    expect(banco.tabelas.profiles).toHaveLength(1);
  });

  it("perfil completo continua respondendo 409 e não é alterado nem apagado", async () => {
    const banco = bancoFalso();
    const store = createAccountStore(banco.admin);
    await store.createProfile("u3", { role: "MUSICIAN", nome: "Ana" });

    await expect(store.createProfile("u3", { role: "MUSICIAN", nome: "Outra" })).rejects.toMatchObject({ code: "PERFIL_EXISTENTE" });
    expect(banco.tabelas.musician_profiles).toEqual([{ user_id: "u3", nome_completo: "Ana" }]);
    expect(banco.chamadas).not.toContain("delete profiles");
  });

  it("duas requisições concorrentes: uma conclui, a outra termina sem erro ou com 409, e nada é apagado", async () => {
    const banco = bancoFalso();
    const store = createAccountStore(banco.admin);
    const perfil = { role: "MUSICIAN" as const, nome: "Ana" };

    const resultados = await Promise.allSettled([store.createProfile("u4", perfil), store.createProfile("u4", perfil)]);

    expect(resultados.filter((r) => r.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
    for (const r of resultados) if (r.status === "rejected") expect(r.reason).toMatchObject({ code: "PERFIL_EXISTENTE" });
    expect(banco.tabelas.profiles).toEqual([{ id: "u4", role: "MUSICIAN" }]);
    expect(banco.tabelas.musician_profiles).toEqual([{ user_id: "u4", nome_completo: "Ana" }]);
    expect(banco.chamadas).not.toContain("delete profiles");
  });

  it("23505 de outra constraint no detalhe não vale como cadastro concluído: o erro sobe, profiles fica e nada é apagado", async () => {
    const banco = bancoFalso({
      erroDoDetalhe: () => ({ code: "23505", message: 'duplicate key value violates unique constraint "musician_profiles_documento_key"', details: "Key (documento)=(12345678909) already exists." }),
    });
    const store = createAccountStore(banco.admin);
    const erros: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void erros.push(args);

    await expect(store.createProfile("u5", { role: "MUSICIAN", nome: "Ana" })).rejects.toMatchObject({ code: "23505", message: expect.stringContaining("documento_key") });

    console.error = original;
    expect(banco.tabelas.profiles).toEqual([{ id: "u5", role: "MUSICIAN" }]);
    expect(banco.tabelas.musician_profiles).toEqual([]);
    expect(banco.chamadas).not.toContain("delete profiles");
    expect(erros[0]?.[0]).toContain("Perfil incompleto");
  });

  it("23505 da chave primária é reconhecido pelo nome da constraint ou pela coluna user_id", async () => {
    for (const erro of [
      { code: "23505", message: 'duplicate key value violates unique constraint "contractor_profiles_pkey"' },
      { code: "23505", message: "duplicate key", details: "Key (user_id)=(u6) already exists." },
    ]) {
      const banco = bancoFalso({ erroDoDetalhe: () => erro });
      await expect(createAccountStore(banco.admin).createProfile("u6", { role: "CONTRACTOR", nome: "Bar" })).resolves.toBeUndefined();
      expect(banco.tabelas.profiles).toEqual([{ id: "u6", role: "CONTRACTOR" }]);
    }
  });

  it("duas requisições concorrentes com papéis diferentes: só a primeira cria o perfil, a outra recebe 409 e não grava detalhe do outro papel", async () => {
    const banco = bancoFalso();
    const store = createAccountStore(banco.admin);

    const resultados = await Promise.allSettled([
      store.createProfile("u7", { role: "MUSICIAN", nome: "Ana" }),
      store.createProfile("u7", { role: "CONTRACTOR", nome: "Bar" }),
    ]);

    expect(resultados.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
    expect((resultados[1] as PromiseRejectedResult).reason).toMatchObject({ code: "PERFIL_EXISTENTE", status: 409 });
    expect(banco.tabelas.profiles).toEqual([{ id: "u7", role: "MUSICIAN" }]);
    expect(banco.tabelas.musician_profiles).toEqual([{ user_id: "u7", nome_completo: "Ana" }]);
    expect(banco.tabelas.contractor_profiles).toEqual([]);
    expect(banco.chamadas).not.toContain("delete profiles");
  });
});

describe("atualização do perfil grava pelo papel da conta", () => {
  function bancoDeAtualizacao() {
    const atualizacoes: { tabela: string; row: Record<string, unknown> }[] = [];
    const from = (tabela: string) => ({
      update: (row: Record<string, unknown>) => ({ eq: async () => { atualizacoes.push({ tabela, row }); return { error: null }; } }),
    });
    return { admin: { from } as unknown as SupabaseClient, atualizacoes };
  }

  it("músico que muda só a bio tem a bio gravada, mesmo sem enviar os estilos", async () => {
    const banco = bancoDeAtualizacao();
    await createAccountStore(banco.admin).updateProfile("u1", "MUSICIAN", { nome: "Ana", bio: "nova bio" });

    expect(banco.atualizacoes).toEqual([{ tabela: "musician_profiles", row: { nome_completo: "Ana", bio: "nova bio" } }]);
  });

  it("troca só da chave Pix e limpeza só das redes também chegam ao banco", async () => {
    const banco = bancoDeAtualizacao();
    const store = createAccountStore(banco.admin);
    await store.updateProfile("u1", "MUSICIAN", { nome: "Ana", chavePix: "ana@ex.com", chavePixTipo: "EMAIL" });
    await store.updateProfile("u1", "MUSICIAN", { nome: "Ana", redesSociais: {}, estilosMusicais: null });

    expect(banco.atualizacoes[0].row).toEqual({ nome_completo: "Ana", chave_pix: "ana@ex.com", chave_pix_tipo: "EMAIL" });
    expect(banco.atualizacoes[1].row).toEqual({ nome_completo: "Ana", redes_sociais: {}, estilos_musicais: null });
  });

  it("contratante nunca recebe colunas de músico e campo omitido não entra no update", async () => {
    const banco = bancoDeAtualizacao();
    await createAccountStore(banco.admin).updateProfile("u2", "CONTRACTOR", { nome: "Bar", telefone: "4532220001", bio: "x", chavePix: "1", chavePixTipo: "CPF" } as never);

    expect(banco.atualizacoes).toEqual([{ tabela: "contractor_profiles", row: { nome_fantasia: "Bar", telefone: "4532220001" } }]);
  });

  it("só o portfólio e só os estilos chegam ao banco como a única coluna além do nome", async () => {
    const banco = bancoDeAtualizacao();
    const store = createAccountStore(banco.admin);
    await store.updateProfile("u1", "MUSICIAN", { nome: "Ana", portfolioUrl: "https://ana.example.com" });
    await store.updateProfile("u1", "MUSICIAN", { nome: "Ana", estilosMusicais: ["Rock", "MPB"] });

    expect(banco.atualizacoes[0].row).toEqual({ nome_completo: "Ana", portfolio_url: "https://ana.example.com" });
    expect(banco.atualizacoes[1].row).toEqual({ nome_completo: "Ana", estilos_musicais: ["Rock", "MPB"] });
  });

  it("só o tipo da chave Pix, sem a chave, não altera a chave gravada", async () => {
    const banco = bancoDeAtualizacao();
    await createAccountStore(banco.admin).updateProfile("u1", "MUSICIAN", { nome: "Ana", chavePixTipo: "CPF" });

    expect(banco.atualizacoes).toEqual([{ tabela: "musician_profiles", row: { nome_completo: "Ana" } }]);
  });

  it("vários campos de uma vez, com apagamentos e foto nova, viram uma única atualização com todas as colunas", async () => {
    const banco = bancoDeAtualizacao();
    await createAccountStore(banco.admin).updateProfile("u1", "MUSICIAN", {
      nome: "Ana Lima",
      telefone: "45999990000",
      uf: null,
      cidade: null,
      bio: "Cantora",
      portfolioUrl: null,
      chavePix: null,
      fotoPerfilUrl: "https://projeto.supabase.co/storage/v1/object/public/avatars/u1/nova.jpg",
    });

    expect(banco.atualizacoes).toEqual([{
      tabela: "musician_profiles",
      row: {
        nome_completo: "Ana Lima",
        telefone: "45999990000",
        uf: null,
        cidade: null,
        bio: "Cantora",
        portfolio_url: null,
        chave_pix: null,
        chave_pix_tipo: null,
        foto_perfil_url: "https://projeto.supabase.co/storage/v1/object/public/avatars/u1/nova.jpg",
      },
    }]);
  });
});
