export const PRAZO_DE_ENCERRAMENTO_MS = 55_000;

export function createEncerramento(deps: {
  fecharServidor: () => Promise<void>;
  pararAgenda: () => Promise<void>;
  sair: (codigo: number) => void;
  prazoMs?: number;
  log?: (mensagem: string) => void;
  erro?: (mensagem: string) => void;
}) {
  const { fecharServidor, pararAgenda, sair, prazoMs = PRAZO_DE_ENCERRAMENTO_MS, log = console.log, erro = console.error } = deps;
  let emCurso: Promise<void> | null = null;

  async function executar(sinal: string): Promise<void> {
    let concluido = false;
    const concluir = (codigo: number) => {
      if (concluido) return;
      concluido = true;
      clearTimeout(prazo);
      sair(codigo);
    };
    log(`Sinal ${sinal} recebido: a API parou de aceitar conexões e aguarda as requisições em andamento.`);
    const prazo = setTimeout(() => {
      erro(`Encerramento não concluído em ${Math.round(prazoMs / 1000)} segundos: saída forçada.`);
      concluir(1);
    }, prazoMs);
    prazo.unref();
    const resultados = await Promise.allSettled([fecharServidor(), pararAgenda()]);
    if (resultados.some((resultado) => resultado.status === "rejected")) {
      erro("Falha ao encerrar a API: saída com erro.");
      concluir(1);
      return;
    }
    if (!concluido) log("API encerrada.");
    concluir(0);
  }

  return {
    encerrar(sinal: string): Promise<void> {
      emCurso ??= executar(sinal);
      return emCurso;
    },
  };
}
