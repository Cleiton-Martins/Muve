import { describe, expect, it } from "vitest";
import { emLotes } from "./lotes.ts";

const esperar = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("processamento em lotes com concorrência limitada", () => {
  it("nunca passa do limite de tarefas simultâneas e processa todos os itens", async () => {
    let ativas = 0;
    let pico = 0;
    const itens = Array.from({ length: 12 }, (_, i) => i);
    const { concluidos, falhas } = await emLotes(itens, 4, async (item) => {
      ativas++;
      pico = Math.max(pico, ativas);
      await esperar(2);
      ativas--;
      return item * 2;
    });

    expect(pico).toBeLessThanOrEqual(4);
    expect(pico).toBeGreaterThan(1);
    expect(falhas).toEqual([]);
    expect(concluidos.map((c) => c.valor).sort((a, b) => a - b)).toEqual(itens.map((i) => i * 2));
  });

  it("começa na ordem da lista", async () => {
    const inicio: number[] = [];
    await emLotes([0, 1, 2, 3, 4], 2, async (item) => { inicio.push(item); await esperar(1); });
    expect(inicio).toEqual([0, 1, 2, 3, 4]);
  });

  it("uma falha isolada não interrompe os demais e fica identificada", async () => {
    const { concluidos, falhas } = await emLotes(["a", "b", "c", "d"], 2, async (item) => {
      if (item === "b") throw new Error("destinatário fora do ar");
      return item.toUpperCase();
    });

    expect(concluidos.map((c) => c.valor).sort()).toEqual(["A", "C", "D"]);
    expect(falhas).toEqual([{ item: "b", erro: expect.objectContaining({ message: "destinatário fora do ar" }) }]);
  });

  it("lista vazia e limite inválido não quebram", async () => {
    expect(await emLotes([], 5, async () => 1)).toEqual({ concluidos: [], falhas: [] });
    const { concluidos } = await emLotes([1, 2], 0, async (item) => item);
    expect(concluidos).toHaveLength(2);
  });
});
