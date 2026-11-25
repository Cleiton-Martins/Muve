import { describe, expect, it } from "vitest";
import { limpezaProibida, montarAlteracoesDoPerfil, type FormularioDoPerfil, type PerfilAtual } from "./perfil.ts";

const musico: PerfilAtual = {
  role: "MUSICIAN",
  nome: "Ana Souza",
  documento: "52998224725",
  telefone: "45999990000",
  uf: "PR",
  cidade: "Cascavel",
  bio: "Voz e violão",
  estilosMusicais: ["MPB", "Rock"],
  chavePixTipo: "CPF",
  chavePix: "52998224725",
  portfolioUrl: "https://ana.com.br",
  redesSociais: { instagram: "https://www.instagram.com/ana", youtube: "https://youtube.com/@ana" },
};

const formularioDe = (me: PerfilAtual): FormularioDoPerfil => ({
  nome: me.nome,
  documento: me.documento ?? "",
  telefone: me.telefone ?? "",
  uf: me.uf ?? "",
  cidade: me.cidade ?? "",
  bio: me.bio ?? "",
  chavePixTipo: me.chavePixTipo ?? "",
  chavePix: me.chavePix ?? "",
  portfolioUrl: me.portfolioUrl ?? "",
  redes: { instagram: me.redesSociais?.instagram ?? "", youtube: me.redesSociais?.youtube ?? "", spotify: me.redesSociais?.spotify ?? "", tiktok: me.redesSociais?.tiktok ?? "" },
  estilos: me.estilosMusicais ?? [],
});

describe("payload do PATCH /me: só o que mudou", () => {
  it("sem mudanças, envia apenas o nome", () => {
    expect(montarAlteracoesDoPerfil(musico, formularioDe(musico))).toEqual({ nome: "Ana Souza" });
  });

  it("campo alterado vai como texto; campo opcional apagado vai como null", () => {
    const form = { ...formularioDe(musico), telefone: "(45) 98888-7777", bio: "   " };
    expect(montarAlteracoesDoPerfil(musico, form)).toEqual({ nome: "Ana Souza", telefone: "45988887777", bio: null });
  });

  it("máscara do documento e do telefone não conta como mudança", () => {
    const form = { ...formularioDe(musico), documento: "529.982.247-25", telefone: "(45) 99999-0000" };
    expect(montarAlteracoesDoPerfil(musico, form)).toEqual({ nome: "Ana Souza" });
  });

  it("estado e cidade são apagados juntos e enviados juntos", () => {
    expect(montarAlteracoesDoPerfil(musico, { ...formularioDe(musico), cidade: "" })).toMatchObject({ uf: null, cidade: null });
    expect(montarAlteracoesDoPerfil(musico, { ...formularioDe(musico), cidade: "Toledo" })).toMatchObject({ uf: "PR", cidade: "Toledo" });
  });

  it("estilos desmarcados viram null; lista igual em outra ordem não muda", () => {
    expect(montarAlteracoesDoPerfil(musico, { ...formularioDe(musico), estilos: [] })).toMatchObject({ estilosMusicais: null });
    expect(montarAlteracoesDoPerfil(musico, { ...formularioDe(musico), estilos: ["Rock", "MPB"] })).toEqual({ nome: "Ana Souza" });
  });

  it("redes vão completas quando qualquer uma muda, para a API não apagar as outras", () => {
    const form = formularioDe(musico);
    form.redes.spotify = "https://open.spotify.com/artist/1";
    expect(montarAlteracoesDoPerfil(musico, form).redesSociais).toEqual({ instagram: "https://www.instagram.com/ana", youtube: "https://youtube.com/@ana", spotify: "https://open.spotify.com/artist/1", tiktok: "" });
  });

  it("site digitado sem protocolo é comparado já com https", () => {
    expect(montarAlteracoesDoPerfil(musico, { ...formularioDe(musico), portfolioUrl: "ana.com.br" })).toEqual({ nome: "Ana Souza" });
    expect(montarAlteracoesDoPerfil(musico, { ...formularioDe(musico), portfolioUrl: "" })).toMatchObject({ portfolioUrl: null });
  });

  it("troca da chave Pix envia chave e tipo; trocar só o tipo também", () => {
    expect(montarAlteracoesDoPerfil(musico, { ...formularioDe(musico), chavePixTipo: "EMAIL", chavePix: "ana@ex.com" })).toMatchObject({ chavePix: "ana@ex.com", chavePixTipo: "EMAIL" });
    expect(montarAlteracoesDoPerfil(musico, { ...formularioDe(musico), chavePixTipo: "CNPJ" })).toMatchObject({ chavePix: "52998224725", chavePixTipo: "CNPJ" });
  });

  it("contratante não envia campos de músico", () => {
    const contratante: PerfilAtual = { role: "CONTRACTOR", nome: "Bar Teste", documento: null, telefone: null, uf: null, cidade: null };
    const form = { ...formularioDe(contratante), bio: "x", estilos: ["Rock"], chavePix: "1", chavePixTipo: "CPF", documento: "45.997.418/0001-53" };
    expect(montarAlteracoesDoPerfil(contratante, form)).toEqual({ nome: "Bar Teste", documento: "45997418000153" });
  });

  it("documento e chave Pix preenchidos não podem ser apagados; vazios desde o início podem continuar vazios", () => {
    expect(limpezaProibida(musico, { ...formularioDe(musico), documento: "" })).toContain("CPF/CNPJ");
    expect(limpezaProibida(musico, { ...formularioDe(musico), chavePix: "" })).toContain("chave Pix");
    const novato: PerfilAtual = { ...musico, documento: null, chavePix: null, chavePixTipo: null };
    expect(limpezaProibida(novato, { ...formularioDe(novato), documento: "", chavePix: "" })).toBeNull();
    expect(montarAlteracoesDoPerfil(novato, formularioDe(novato))).toEqual({ nome: "Ana Souza" });
  });
});
