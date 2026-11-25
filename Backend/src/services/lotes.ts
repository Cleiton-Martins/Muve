export interface ResultadoDoLote<T, R> {
  concluidos: { item: T; valor: R }[];
  falhas: { item: T; erro: unknown }[];
}

export async function emLotes<T, R>(itens: readonly T[], concorrencia: number, tarefa: (item: T, indice: number) => Promise<R>): Promise<ResultadoDoLote<T, R>> {
  const limite = Math.max(1, Math.floor(concorrencia));
  const resultado: ResultadoDoLote<T, R> = { concluidos: [], falhas: [] };
  const fila = itens.map((item, indice) => ({ item, indice }));
  let proximo = 0;
  const trabalhador = async () => {
    while (proximo < fila.length) {
      const { item, indice } = fila[proximo++];
      try {
        resultado.concluidos.push({ item, valor: await tarefa(item, indice) });
      } catch (erro) {
        resultado.falhas.push({ item, erro });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limite, fila.length) }, trabalhador));
  return resultado;
}

export const descreverFalhas = <T>(contexto: string, falhas: { item: T; erro: unknown }[], rotulo: (item: T) => string) => {
  if (falhas.length === 0) return;
  console.error(`${contexto}: ${falhas.length} falha(s)`, falhas.map(({ item, erro }) => `${rotulo(item)}: ${erro instanceof Error ? erro.message : "falha inesperada"}`).join("; "));
};
