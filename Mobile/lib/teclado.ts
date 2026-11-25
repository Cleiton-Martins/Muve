export const MARGEM_DO_CAMPO = 24;

export interface CampoNaJanela { topo: number; altura: number }

export interface LimitesVisiveis { topo: number; fundo: number }

export function deslocamentoParaMostrarCampo(campo: CampoNaJanela, limites: LimitesVisiveis, margem = MARGEM_DO_CAMPO): number {
  const fundoDoCampo = campo.topo + campo.altura + margem;
  if (fundoDoCampo > limites.fundo) return Math.min(fundoDoCampo - limites.fundo, Math.max(campo.topo - limites.topo, 0));
  const topoDoCampo = campo.topo - margem;
  if (topoDoCampo < limites.topo) return topoDoCampo - limites.topo;
  return 0;
}

export const limitesComTeclado = (alturaDaJanela: number, tecladoEm: number | null, topo = 0): LimitesVisiveis => ({ topo, fundo: tecladoEm === null ? alturaDaJanela : Math.min(alturaDaJanela, tecladoEm) });

export const novaPosicaoDaRolagem = (posicaoAtual: number, deslocamento: number) => Math.max(0, posicaoAtual + deslocamento);
