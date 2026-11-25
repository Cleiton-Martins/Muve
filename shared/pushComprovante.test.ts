import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  base64UrlDe32Bytes,
  bytesDaOperacao,
  bytesDoToken,
  bytesParaBase64Url,
  bytesParaHex,
  calcularComprovante,
  calcularComprovanteBase64Url,
  ComprovanteInvalido,
  iguaisEmTempoConstante,
  novaOperacao,
  operacaoDosBytes,
  sha256,
  utf8Estrito,
} from "./pushComprovante.ts";

const hex = (bytes: Uint8Array) => bytesParaHex(bytes);
const segredoSequencial = Uint8Array.from({ length: 32 }, (_, i) => i);
const OPERACAO = "0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e";
const TOKEN_MULTIBYTE = "ExponentPushToken[vetor-ação-é-🎵]";

describe("vetores independentes (calculados com Python hashlib, fora desta implementação)", () => {
  it("token com caracteres multibyte", () => {
    expect(utf8Estrito(TOKEN_MULTIBYTE)).toHaveLength(39);
    expect(hex(calcularComprovante(TOKEN_MULTIBYTE, OPERACAO, segredoSequencial))).toBe("561b11a6ebce4de04929d9972e900369abc1420824a788c8d5d9e3cc628fbd9f");
    expect(calcularComprovanteBase64Url(TOKEN_MULTIBYTE, OPERACAO, "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8")).toBe("VhsRpuvOTeBJKdmXLpADaavBQggkp4jI1dnjzGKPvZ8");
  });

  it("UUID nulo e segredo com todos os bits ligados", () => {
    expect(hex(calcularComprovante("ExponentPushToken[abc]", "00000000-0000-0000-0000-000000000000", new Uint8Array(32).fill(0xff)))).toBe(
      "140a8f7e787314630e005f1da12a3b8622617931789e1437496ca521d064536d",
    );
  });

  it("limites do token: 1 byte e 65.535 bytes", () => {
    expect(hex(calcularComprovante("x", OPERACAO, segredoSequencial))).toBe("128af5e2e9f0aeeec5464f25b90455116669db31c8650b591eea30ec0cc3866b");
    expect(hex(calcularComprovante("a".repeat(65535), OPERACAO, segredoSequencial))).toBe("699e4bfc71490142b8348a3d5c083a36ba779a8a891041b6c4bb229144d550cd");
  });
});

describe("SHA-256", () => {
  it("vetores do FIPS 180-2", () => {
    expect(hex(sha256(new Uint8Array()))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(hex(sha256(utf8Estrito("abc")))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(hex(sha256(utf8Estrito("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")))).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
  });

  it("confere com node:crypto em tamanhos que cruzam os limites de bloco", () => {
    for (const tamanho of [0, 1, 54, 55, 56, 63, 64, 65, 119, 120, 128, 1000, 65_700]) {
      const dados = randomBytes(tamanho);
      expect(hex(sha256(new Uint8Array(dados)))).toBe(createHash("sha256").update(dados).digest("hex"));
    }
  });
});

describe("conversões", () => {
  it("operation_id vira os 16 bytes do UUID na ordem dos pares hexadecimais", () => {
    expect(hex(bytesDaOperacao(OPERACAO))).toBe("0f1e2d3c4b5a49688778695a4b3c2d1e");
    expect(hex(bytesDaOperacao(OPERACAO.toUpperCase()))).toBe("0f1e2d3c4b5a49688778695a4b3c2d1e");
    expect(operacaoDosBytes(bytesDaOperacao(OPERACAO))).toBe(OPERACAO);
  });

  it("nova operação gera UUID v4 canônico", () => {
    const operacao = novaOperacao(new Uint8Array(16).fill(0xff));
    expect(operacao).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
    expect(() => novaOperacao(new Uint8Array(15))).toThrow(ComprovanteInvalido);
  });

  it("Base64URL de 32 bytes, ida e volta", () => {
    const segredo = new Uint8Array(randomBytes(32));
    const texto = bytesParaBase64Url(segredo);
    expect(texto).toHaveLength(43);
    expect(texto).toBe(Buffer.from(segredo).toString("base64url"));
    expect(base64UrlDe32Bytes(texto, "segredo")).toEqual(segredo);
  });

  it("preserva os bytes do token sem trim, caixa ou normalização", () => {
    expect(hex(bytesDoToken(" A"))).toBe("2041");
    expect(hex(bytesDoToken("é"))).toBe("c3a9");
    expect(hex(bytesDoToken("é"))).toBe("65cc81");
    expect(hex(calcularComprovante("é", OPERACAO, segredoSequencial))).not.toBe(hex(calcularComprovante("é", OPERACAO, segredoSequencial)));
    expect(hex(calcularComprovante("a", OPERACAO, segredoSequencial))).not.toBe(hex(calcularComprovante("A", OPERACAO, segredoSequencial)));
  });

  it("comparação em tempo constante", () => {
    expect(iguaisEmTempoConstante(Uint8Array.from([1, 2]), Uint8Array.from([1, 2]))).toBe(true);
    expect(iguaisEmTempoConstante(Uint8Array.from([1, 2]), Uint8Array.from([1, 3]))).toBe(false);
    expect(iguaisEmTempoConstante(Uint8Array.from([1, 2]), Uint8Array.from([1, 2, 0]))).toBe(false);
  });
});

describe("recusas", () => {
  const recusa = (acao: () => unknown, campo: string) => {
    try {
      acao();
    } catch (erro) {
      expect(erro).toBeInstanceOf(ComprovanteInvalido);
      expect((erro as ComprovanteInvalido).campo).toBe(campo);
      return;
    }
    throw new Error("deveria ter recusado");
  };

  it("token vazio, ausente, maior que 65.535 bytes ou com UTF-16 incompleto", () => {
    recusa(() => calcularComprovante("", OPERACAO, segredoSequencial), "token");
    recusa(() => calcularComprovante(undefined, OPERACAO, segredoSequencial), "token");
    recusa(() => calcularComprovante("a".repeat(65536), OPERACAO, segredoSequencial), "token");
    recusa(() => calcularComprovante("é".repeat(32768), OPERACAO, segredoSequencial), "token");
    recusa(() => calcularComprovante("a\ud800", OPERACAO, segredoSequencial), "token");
    recusa(() => calcularComprovante("\udc00a", OPERACAO, segredoSequencial), "token");
    expect(bytesDoToken("é".repeat(32767) + "a")).toHaveLength(65535);
  });

  it("operation_id fora do formato canônico", () => {
    for (const invalido of ["", "0f1e2d3c4b5a49688778695a4b3c2d1e", "{0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e}", "0f1e2d3c-4b5a-4968-8778-695a4b3c2d1", "0f1e2d3c-4b5a-4968-8778-695a4b3c2d1ex", 42]) {
      recusa(() => calcularComprovante("x", invalido, segredoSequencial), "operationId");
    }
  });

  it("segredo com tamanho ou codificação errados", () => {
    recusa(() => calcularComprovante("x", OPERACAO, new Uint8Array(31)), "segredo");
    recusa(() => calcularComprovante("x", OPERACAO, new Uint8Array(33)), "segredo");
    const valido = bytesParaBase64Url(segredoSequencial);
    for (const invalido of [valido.slice(1), `${valido}A`, `${valido}=`, valido.replace("A", "+"), valido.replace(/.$/, "9"), "", null]) {
      recusa(() => calcularComprovanteBase64Url("x", OPERACAO, invalido), "segredo");
    }
  });
});
