import { describe, expect, it } from "vitest";
import { updateProfileSchemas } from "./account.ts";

describe("redes sociais no perfil do músico", () => {
  const perfil = (redesSociais: unknown) => updateProfileSchemas.MUSICIAN.safeParse({ nome: "Banda Teste", redesSociais });

  it("guarda só as redes preenchidas, já como link", () => {
    const resultado = perfil({ instagram: "@bandateste", youtube: "", spotify: "https://open.spotify.com/artist/1" });

    expect(resultado.success && resultado.data.redesSociais).toEqual({ instagram: "https://www.instagram.com/bandateste", spotify: "https://open.spotify.com/artist/1" });
  });

  it("recusa link de outra rede e diz qual campo está errado", () => {
    const resultado = perfil({ tiktok: "https://instagram.com/bandateste" });

    expect(resultado.success).toBe(false);
    expect(resultado.error?.issues[0]?.message).toBe("Informe o @ ou um link válido do TikTok.");
  });

  it("ignora rede que o app não conhece", () => {
    expect(perfil({ facebook: "https://facebook.com/banda" }).success).toBe(true);
    expect(perfil({ facebook: "https://facebook.com/banda" }).data?.redesSociais).toEqual({});
  });

  it("sem o campo, as redes ficam como estão", () => {
    expect(perfil(undefined).data?.redesSociais).toBeUndefined();
  });
});

describe("PATCH /me: omitido, vazio e null", () => {
  const musico = (dados: object) => updateProfileSchemas.MUSICIAN.safeParse({ nome: "Ana", ...dados });
  const contratante = (dados: object) => updateProfileSchemas.CONTRACTOR.safeParse({ nome: "Bar", ...dados });

  it("campo omitido fica undefined (mantém o valor atual)", () => {
    const r = musico({});
    expect(r.success).toBe(true);
    expect(r.data).toMatchObject({ nome: "Ana" });
    expect(r.data?.documento).toBeUndefined();
    expect(r.data?.estilosMusicais).toBeUndefined();
    expect(r.data?.chavePix).toBeUndefined();
  });

  it("texto vazio e null viram null nos campos apagáveis, para o serviço decidir", () => {
    expect(musico({ telefone: "", bio: "  ", portfolioUrl: null }).data).toMatchObject({ telefone: null, bio: null, portfolioUrl: null });
    expect(contratante({ documento: "", telefone: null }).data).toMatchObject({ documento: null, telefone: null });
  });

  it("lista de estilos vazia ou null vira null; com itens, deduplica", () => {
    expect(musico({ estilosMusicais: [] }).data?.estilosMusicais).toBeNull();
    expect(musico({ estilosMusicais: null }).data?.estilosMusicais).toBeNull();
    expect(musico({ estilosMusicais: ["MPB", "MPB", "Rock"] }).data?.estilosMusicais).toEqual(["MPB", "Rock"]);
  });

  it("chave Pix apagada leva o tipo junto; chave nova normaliza os dois", () => {
    expect(musico({ chavePix: null, chavePixTipo: "CPF" }).data).toMatchObject({ chavePix: null, chavePixTipo: null });
    expect(musico({ chavePix: "", chavePixTipo: "" }).data).toMatchObject({ chavePix: null, chavePixTipo: null });
    expect(musico({ chavePix: "529.982.247-25", chavePixTipo: "CPF" }).data).toMatchObject({ chavePix: "52998224725", chavePixTipo: "CPF" });
  });

  it("estado e cidade só são apagados juntos", () => {
    expect(musico({ uf: null, cidade: null }).data).toMatchObject({ uf: null, cidade: null });
    const soUf = contratante({ uf: null, cidade: "Cascavel" });
    expect(soUf.success).toBe(false);
    expect(soUf.error?.issues[0]).toMatchObject({ path: ["cidade"], message: "Estado e cidade são apagados juntos." });
    expect(contratante({ uf: "PR", cidade: "Cascavel" }).data).toMatchObject({ uf: "PR", cidade: "Cascavel" });
  });

  it("valores inválidos continuam recusados", () => {
    expect(musico({ documento: "123" }).success).toBe(false);
    expect(musico({ telefone: "99" }).success).toBe(false);
    expect(contratante({ uf: "XX", cidade: "Cascavel" }).success).toBe(false);
  });
});

describe("chave Pix no perfil do músico", () => {
  it("o erro aponta o campo, para a mensagem chegar ao app em vez de \"Dados inválidos.\"", () => {
    const semTipo = updateProfileSchemas.MUSICIAN.safeParse({ nome: "Banda Teste", chavePix: "123" });
    const invalida = updateProfileSchemas.MUSICIAN.safeParse({ nome: "Banda Teste", chavePixTipo: "CPF", chavePix: "123" });

    expect(semTipo.error?.issues[0]).toMatchObject({ path: ["chavePixTipo"], message: "Selecione o tipo da chave Pix." });
    expect(invalida.error?.issues[0]).toMatchObject({ path: ["chavePix"], message: "Chave Pix inválida para o tipo selecionado." });
  });
});
