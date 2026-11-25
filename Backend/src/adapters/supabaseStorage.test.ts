import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createImageStore } from "./supabase.ts";

const BASE = "https://projeto.supabase.co/storage/v1/object/public";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

type Chamada = { operacao: string; bucket: string; args: unknown[] };

function storageFalso(opcoes: { listagem?: Record<string, string[]>; falharEm?: string } = {}) {
  const chamadas: Chamada[] = [];
  const registrar = (operacao: string, bucket: string, ...args: unknown[]) => {
    chamadas.push({ operacao, bucket, args });
    return opcoes.falharEm === operacao ? { error: { message: `falha simulada em ${operacao}` } } : { error: null };
  };
  const from = (bucket: string) => ({
    upload: async (path: string, file: File, options: unknown) => registrar("upload", bucket, path, file.type, options),
    copy: async (origem: string, destino: string) => registrar("copy", bucket, origem, destino),
    remove: async (paths: string[]) => registrar("remove", bucket, paths),
    list: async (prefixo: string) => {
      chamadas.push({ operacao: "list", bucket, args: [prefixo] });
      return { data: (opcoes.listagem?.[prefixo] ?? []).map((name) => ({ name })), error: null };
    },
    getPublicUrl: (path: string) => ({ data: { publicUrl: `${BASE}/${bucket}/${path}` } }),
  });
  return { admin: { storage: { from } } as unknown as SupabaseClient, chamadas };
}

const caminhoDe = (url: string, bucket: string) => url.slice(`${BASE}/${bucket}/`.length);

describe("createImageStore.upload", () => {
  it("grava em <dono>/<uuid>.<extensão> sem sobrescrever e devolve a URL pública", async () => {
    const storage = storageFalso();
    const store = createImageStore(storage.admin);

    const png = await store.upload("avatars", "u1", new File([PNG], "foto.png", { type: "image/png" }));
    const jpeg = await store.upload("event-banners", "c1", new File([JPEG], "capa.jpeg", { type: "image/jpeg" }));

    expect(caminhoDe(png, "avatars")).toMatch(new RegExp(`^u1/${UUID}\\.png$`));
    expect(caminhoDe(jpeg, "event-banners")).toMatch(new RegExp(`^c1/${UUID}\\.jpg$`));
    expect(storage.chamadas).toEqual([
      { operacao: "upload", bucket: "avatars", args: [caminhoDe(png, "avatars"), "image/png", { contentType: "image/png", upsert: false }] },
      { operacao: "upload", bucket: "event-banners", args: [caminhoDe(jpeg, "event-banners"), "image/jpeg", { contentType: "image/jpeg", upsert: false }] },
    ]);
  });

  it("recusa com 400 um arquivo cujo conteúdo não é a imagem declarada, sem chamar o Storage", async () => {
    const storage = storageFalso();
    const falso = new File([new TextEncoder().encode("<script>alert(1)</script>")], "foto.png", { type: "image/png" });

    await expect(createImageStore(storage.admin).upload("avatars", "u1", falso)).rejects.toMatchObject({ status: 400, code: "IMAGEM_INVALIDA" });
    expect(storage.chamadas).toEqual([]);
  });

  it("propaga a falha do Storage", async () => {
    const storage = storageFalso({ falharEm: "upload" });

    await expect(createImageStore(storage.admin).upload("avatars", "u1", new File([PNG], "foto.png", { type: "image/png" }))).rejects.toMatchObject({ message: "falha simulada em upload" });
  });
});

describe("createImageStore.copy", () => {
  it("copia para um novo nome na mesma pasta, mantendo a extensão, e devolve a URL da cópia", async () => {
    const storage = storageFalso();

    const copia = await createImageStore(storage.admin).copy("event-banners", `${BASE}/event-banners/c1/original.jpg`);

    expect(caminhoDe(copia, "event-banners")).toMatch(new RegExp(`^c1/${UUID}\\.jpg$`));
    expect(storage.chamadas).toEqual([{ operacao: "copy", bucket: "event-banners", args: ["c1/original.jpg", caminhoDe(copia, "event-banners")] }]);
  });

  it("decodifica o caminho da URL antes de copiar", async () => {
    const storage = storageFalso();

    await createImageStore(storage.admin).copy("event-banners", `${BASE}/event-banners/c1/capa%20do%20show.png`);

    expect(storage.chamadas[0].args[0]).toBe("c1/capa do show.png");
    expect(String(storage.chamadas[0].args[1])).toMatch(new RegExp(`^c1/${UUID}\\.png$`));
  });

  it("recusa com 400 uma URL de outro bucket ou de outro armazenamento, sem chamar o Storage", async () => {
    const storage = storageFalso();
    const store = createImageStore(storage.admin);

    await expect(store.copy("event-banners", `${BASE}/avatars/u1/foto.png`)).rejects.toMatchObject({ status: 400, code: "IMAGEM_INVALIDA" });
    await expect(store.copy("event-banners", "https://cdn.exemplo.com/capa.jpg")).rejects.toMatchObject({ status: 400, code: "IMAGEM_INVALIDA" });
    expect(storage.chamadas).toEqual([]);
  });

  it("propaga a falha do Storage", async () => {
    const storage = storageFalso({ falharEm: "copy" });

    await expect(createImageStore(storage.admin).copy("event-banners", `${BASE}/event-banners/c1/original.jpg`)).rejects.toMatchObject({ message: "falha simulada em copy" });
  });
});

describe("createImageStore.removeByUrl e removeAllOf", () => {
  it("remove pelo caminho extraído da URL e ignora URLs que não são deste armazenamento", async () => {
    const storage = storageFalso();
    const store = createImageStore(storage.admin);

    await store.removeByUrl("avatars", `${BASE}/avatars/u1/antiga.png`);
    await store.removeByUrl("avatars", "https://cdn.exemplo.com/antiga.png");
    await store.removeByUrl("avatars", `${BASE}/event-banners/c1/capa.jpg`);

    expect(storage.chamadas).toEqual([{ operacao: "remove", bucket: "avatars", args: [["u1/antiga.png"]] }]);
  });

  it("removeAllOf lista a pasta do dono e remove tudo de uma vez; pasta vazia não chama remove", async () => {
    const storage = storageFalso({ listagem: { c1: ["a.jpg", "b.png"] } });
    const store = createImageStore(storage.admin);

    await store.removeAllOf("event-banners", "c1");
    await store.removeAllOf("event-banners", "c2");

    expect(storage.chamadas).toEqual([
      { operacao: "list", bucket: "event-banners", args: ["c1"] },
      { operacao: "remove", bucket: "event-banners", args: [["c1/a.jpg", "c1/b.png"]] },
      { operacao: "list", bucket: "event-banners", args: ["c2"] },
    ]);
  });

  it("propaga a falha do Storage na remoção", async () => {
    const storage = storageFalso({ falharEm: "remove", listagem: { u1: ["a.png"] } });
    const store = createImageStore(storage.admin);

    await expect(store.removeByUrl("avatars", `${BASE}/avatars/u1/a.png`)).rejects.toMatchObject({ message: "falha simulada em remove" });
    await expect(store.removeAllOf("avatars", "u1")).rejects.toMatchObject({ message: "falha simulada em remove" });
  });
});
