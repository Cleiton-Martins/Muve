export const PUSH_COMPROVANTE_DOMINIO = "newmuve-push-revogacao-v1";
export const PUSH_TOKEN_BYTES_MAXIMO = 65535;
export const PUSH_OPERACAO_BYTES = 16;
export const PUSH_SEGREDO_BYTES = 32;
export const PUSH_COMPROVANTE_BYTES = 32;
export const PUSH_BASE64URL_32_BYTES = 43;

export type CampoDoComprovante = "token" | "operationId" | "segredo" | "comprovante";

export class ComprovanteInvalido extends Error {
  readonly campo: CampoDoComprovante;

  constructor(campo: CampoDoComprovante, mensagem: string) {
    super(mensagem);
    this.name = "ComprovanteInvalido";
    this.campo = campo;
  }
}

export function utf8Estrito(texto: string, campo: CampoDoComprovante = "token"): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < texto.length; i++) {
    let ponto = texto.charCodeAt(i);
    if (ponto >= 0xd800 && ponto <= 0xdbff) {
      const seguinte = i + 1 < texto.length ? texto.charCodeAt(i + 1) : 0;
      if (seguinte < 0xdc00 || seguinte > 0xdfff) throw new ComprovanteInvalido(campo, "Texto com caractere UTF-16 incompleto.");
      ponto = 0x10000 + ((ponto - 0xd800) << 10) + (seguinte - 0xdc00);
      i++;
    } else if (ponto >= 0xdc00 && ponto <= 0xdfff) {
      throw new ComprovanteInvalido(campo, "Texto com caractere UTF-16 incompleto.");
    }
    if (ponto < 0x80) bytes.push(ponto);
    else if (ponto < 0x800) bytes.push(0xc0 | (ponto >> 6), 0x80 | (ponto & 0x3f));
    else if (ponto < 0x10000) bytes.push(0xe0 | (ponto >> 12), 0x80 | ((ponto >> 6) & 0x3f), 0x80 | (ponto & 0x3f));
    else bytes.push(0xf0 | (ponto >> 18), 0x80 | ((ponto >> 12) & 0x3f), 0x80 | ((ponto >> 6) & 0x3f), 0x80 | (ponto & 0x3f));
  }
  return Uint8Array.from(bytes);
}

export function bytesDoToken(token: unknown): Uint8Array {
  if (typeof token !== "string") throw new ComprovanteInvalido("token", "Token ausente.");
  const bytes = utf8Estrito(token, "token");
  if (bytes.length === 0) throw new ComprovanteInvalido("token", "Token vazio.");
  if (bytes.length > PUSH_TOKEN_BYTES_MAXIMO) throw new ComprovanteInvalido("token", "Token maior que 65.535 bytes.");
  return bytes;
}

const UUID_CANONICO = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function operacaoValida(operationId: unknown): operationId is string {
  return typeof operationId === "string" && UUID_CANONICO.test(operationId);
}

export function bytesDaOperacao(operationId: unknown): Uint8Array {
  if (!operacaoValida(operationId)) throw new ComprovanteInvalido("operationId", "operation_id deve ser um UUID canônico.");
  const hex = operationId.replace(/-/g, "");
  const bytes = new Uint8Array(PUSH_OPERACAO_BYTES);
  for (let i = 0; i < PUSH_OPERACAO_BYTES; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

export function operacaoDosBytes(bytes: Uint8Array): string {
  if (bytes.length !== PUSH_OPERACAO_BYTES) throw new ComprovanteInvalido("operationId", "operation_id precisa de 16 bytes.");
  const hex = bytesParaHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function novaOperacao(aleatorios: Uint8Array): string {
  if (aleatorios.length !== PUSH_OPERACAO_BYTES) throw new ComprovanteInvalido("operationId", "operation_id precisa de 16 bytes aleatórios.");
  const bytes = Uint8Array.from(aleatorios);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return operacaoDosBytes(bytes);
}

export function bytesParaHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

const ALFABETO_BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function bytesParaBase64Url(bytes: Uint8Array): string {
  let saida = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const bloco = (a << 16) | (b << 8) | c;
    saida += ALFABETO_BASE64URL[(bloco >> 18) & 63] + ALFABETO_BASE64URL[(bloco >> 12) & 63];
    if (i + 1 < bytes.length) saida += ALFABETO_BASE64URL[(bloco >> 6) & 63];
    if (i + 2 < bytes.length) saida += ALFABETO_BASE64URL[bloco & 63];
  }
  return saida;
}

export function base64UrlDe32Bytes(valor: unknown, campo: "segredo" | "comprovante"): Uint8Array {
  if (typeof valor !== "string" || valor.length !== PUSH_BASE64URL_32_BYTES || !/^[A-Za-z0-9_-]+$/.test(valor)) {
    throw new ComprovanteInvalido(campo, "Valor deve ter 32 bytes em Base64URL sem preenchimento.");
  }
  const bytes = new Uint8Array(PUSH_SEGREDO_BYTES);
  let acumulado = 0;
  let bits = 0;
  let posicao = 0;
  for (const caractere of valor) {
    acumulado = (acumulado << 6) | ALFABETO_BASE64URL.indexOf(caractere);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[posicao++] = (acumulado >> bits) & 0xff;
    }
  }
  if (posicao !== PUSH_SEGREDO_BYTES || bytesParaBase64Url(bytes) !== valor) {
    throw new ComprovanteInvalido(campo, "Valor deve ter 32 bytes em Base64URL canônico.");
  }
  return bytes;
}

const K = Uint32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const girar = (valor: number, bits: number) => (valor >>> bits) | (valor << (32 - bits));

export function sha256(mensagem: Uint8Array): Uint8Array {
  const tamanhoComPreenchimento = Math.ceil((mensagem.length + 9) / 64) * 64;
  const bloco = new Uint8Array(tamanhoComPreenchimento);
  bloco.set(mensagem);
  bloco[mensagem.length] = 0x80;
  const bitsAltos = Math.floor((mensagem.length * 8) / 0x100000000);
  const bitsBaixos = (mensagem.length * 8) >>> 0;
  const visao = new DataView(bloco.buffer);
  visao.setUint32(tamanhoComPreenchimento - 8, bitsAltos);
  visao.setUint32(tamanhoComPreenchimento - 4, bitsBaixos);

  const h = Uint32Array.from([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  for (let inicio = 0; inicio < tamanhoComPreenchimento; inicio += 64) {
    for (let t = 0; t < 16; t++) w[t] = visao.getUint32(inicio + t * 4);
    for (let t = 16; t < 64; t++) {
      const s0 = girar(w[t - 15], 7) ^ girar(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = girar(w[t - 2], 17) ^ girar(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let t = 0; t < 64; t++) {
      const somaE = girar(e, 6) ^ girar(e, 11) ^ girar(e, 25);
      const escolha = (e & f) ^ (~e & g);
      const temp1 = (hh + somaE + escolha + K[t] + w[t]) >>> 0;
      const somaA = girar(a, 2) ^ girar(a, 13) ^ girar(a, 22);
      const maioria = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (somaA + maioria) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }
  const resumo = new Uint8Array(32);
  const saida = new DataView(resumo.buffer);
  for (let i = 0; i < 8; i++) saida.setUint32(i * 4, h[i]);
  return resumo;
}

export function calcularComprovante(token: unknown, operationId: unknown, segredo: Uint8Array): Uint8Array {
  const bytesToken = bytesDoToken(token);
  const bytesOperacao = bytesDaOperacao(operationId);
  if (!(segredo instanceof Uint8Array) || segredo.length !== PUSH_SEGREDO_BYTES) {
    throw new ComprovanteInvalido("segredo", "O segredo precisa de exatamente 32 bytes.");
  }
  const dominio = utf8Estrito(PUSH_COMPROVANTE_DOMINIO);
  const mensagem = new Uint8Array(dominio.length + 1 + 2 + bytesToken.length + PUSH_OPERACAO_BYTES + PUSH_SEGREDO_BYTES);
  let posicao = 0;
  mensagem.set(dominio, posicao);
  posicao += dominio.length;
  mensagem[posicao++] = 0x00;
  mensagem[posicao++] = (bytesToken.length >> 8) & 0xff;
  mensagem[posicao++] = bytesToken.length & 0xff;
  mensagem.set(bytesToken, posicao);
  posicao += bytesToken.length;
  mensagem.set(bytesOperacao, posicao);
  posicao += PUSH_OPERACAO_BYTES;
  mensagem.set(segredo, posicao);
  return sha256(mensagem);
}

export function calcularComprovanteBase64Url(token: unknown, operationId: unknown, segredoBase64Url: unknown): string {
  return bytesParaBase64Url(calcularComprovante(token, operationId, base64UrlDe32Bytes(segredoBase64Url, "segredo")));
}

export function iguaisEmTempoConstante(a: Uint8Array, b: Uint8Array): boolean {
  let diferenca = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diferenca |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diferenca === 0;
}
