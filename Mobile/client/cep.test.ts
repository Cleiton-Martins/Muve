import { afterEach, describe, expect, it, vi } from "vitest";
import { decidirEnderecoDoCep, enderecoDoCep, formatCep, lookupCep } from "./cep.ts";

const respond = (body: object, status = 200) => vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));

afterEach(() => vi.unstubAllGlobals());

describe("consulta de CEP", () => {
  it("formata enquanto a pessoa digita", () => {
    expect(formatCep("85810")).toBe("85810");
    expect(formatCep("85810010999")).toBe("85810-010");
  });

  it("devolve o endereço encontrado", async () => {
    respond({ logradouro: "Avenida Brasil", bairro: "Centro", localidade: "Cascavel", uf: "PR" });

    await expect(lookupCep("85810-010")).resolves.toEqual({ logradouro: "Avenida Brasil", bairro: "Centro", cidade: "Cascavel", uf: "PR" });
  });

  it("explica CEP incompleto sem consultar o serviço", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(lookupCep("8581")).rejects.toThrow("8 números");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("diferencia CEP inexistente de serviço fora do ar", async () => {
    respond({ erro: "true" });
    await expect(lookupCep("00000000")).rejects.toThrow("não encontrado");

    respond({}, 500);
    await expect(lookupCep("85810010")).rejects.toThrow("Não foi possível");

    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("sem rede"); }));
    await expect(lookupCep("85810010")).rejects.toThrow("Não foi possível");
  });
});

describe("preenchimento do endereço pelo CEP", () => {
  const encontrado = { logradouro: "Avenida Brasil", bairro: "Centro" };

  it("monta rua e bairro, ignorando partes vazias", () => {
    expect(enderecoDoCep(encontrado)).toBe("Avenida Brasil - Centro");
    expect(enderecoDoCep({ logradouro: "", bairro: " Centro " })).toBe("Centro");
    expect(enderecoDoCep({ logradouro: "", bairro: "" })).toBe("");
  });

  it("com o endereço vazio, preenche automaticamente", () => {
    expect(decidirEnderecoDoCep("", encontrado)).toEqual({ acao: "preencher", endereco: "Avenida Brasil - Centro" });
    expect(decidirEnderecoDoCep("   ", encontrado)).toEqual({ acao: "preencher", endereco: "Avenida Brasil - Centro" });
  });

  it("com um endereço já digitado, mantém o que a pessoa escreveu e só sugere", () => {
    expect(decidirEnderecoDoCep("Avenida Brasil, 1500 - Centro, perto da praça", encontrado)).toEqual({ acao: "manter", sugestao: "Avenida Brasil - Centro" });
  });

  it("endereço igual à sugestão é reaplicado sem perda", () => {
    expect(decidirEnderecoDoCep("Avenida Brasil - Centro", encontrado)).toEqual({ acao: "preencher", endereco: "Avenida Brasil - Centro" });
  });

  it("CEP sem logradouro nem bairro (cidade com CEP único) não mexe no endereço", () => {
    expect(decidirEnderecoDoCep("Rua das Flores, 10", { logradouro: "", bairro: "" })).toEqual({ acao: "nada" });
    expect(decidirEnderecoDoCep("", { logradouro: "", bairro: "" })).toEqual({ acao: "nada" });
  });
});
