import { describe, expect, it } from "vitest";
import { deslocamentoParaMostrarCampo, limitesComTeclado, MARGEM_DO_CAMPO, novaPosicaoDaRolagem } from "./teclado.ts";

const janela = 800;

describe("rolagem até o campo focado", () => {
  it("campo no início da tela, acima do teclado, não precisa rolar", () => {
    const limites = limitesComTeclado(janela, 500);
    expect(deslocamentoParaMostrarCampo({ topo: 120, altura: 50 }, limites)).toBe(0);
  });

  it("campo escondido atrás do teclado rola o suficiente para ficar visível com margem", () => {
    const limites = limitesComTeclado(janela, 500);
    expect(deslocamentoParaMostrarCampo({ topo: 600, altura: 50 }, limites)).toBe(600 + 50 + MARGEM_DO_CAMPO - 500);
  });

  it("campo no final de um formulário longo, abaixo da janela, também rola", () => {
    const limites = limitesComTeclado(janela, 500);
    expect(deslocamentoParaMostrarCampo({ topo: 1200, altura: 96 }, limites)).toBeGreaterThan(0);
  });

  it("campo mais alto que a área visível nunca rola o topo para fora da tela", () => {
    const limites = limitesComTeclado(janela, 300);
    const deslocamento = deslocamentoParaMostrarCampo({ topo: 100, altura: 400 }, limites);
    expect(deslocamento).toBe(100);
  });

  it("campo parcialmente acima do topo visível rola para cima (valor negativo)", () => {
    const limites = limitesComTeclado(janela, null, 80);
    expect(deslocamentoParaMostrarCampo({ topo: 60, altura: 50 }, limites)).toBe(60 - MARGEM_DO_CAMPO - 80);
  });

  it("sem teclado aberto, o limite inferior é a própria janela", () => {
    expect(limitesComTeclado(janela, null)).toEqual({ topo: 0, fundo: janela });
    expect(limitesComTeclado(janela, 520)).toEqual({ topo: 0, fundo: 520 });
    expect(limitesComTeclado(janela, 900)).toEqual({ topo: 0, fundo: janela });
  });

  it("a nova posição nunca fica negativa", () => {
    expect(novaPosicaoDaRolagem(10, -50)).toBe(0);
    expect(novaPosicaoDaRolagem(100, 40)).toBe(140);
  });
});
