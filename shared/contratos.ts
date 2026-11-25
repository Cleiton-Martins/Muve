export type EventStatus = "ABERTO" | "CONTRATADO" | "CANCELADO" | "CONCLUIDO";
export type CandidateStatus = "PENDENTE" | "APROVADO" | "RECUSADO";
export type PaymentStatus = "PENDENTE" | "PAGO" | "EXPIRADO" | "CANCELADO" | "ESTORNADO";
export type PayoutStatus = "RETIDO" | "PROCESSANDO" | "REPASSADO" | "FALHOU";

export interface Hiring {
  papel: "contratante" | "musico";
  evento: {
    id: string;
    titulo: string;
    tipoEvento: string;
    inicio: string;
    duracaoMinutos: number;
    cidade: string;
    uf: string;
    endereco: string | null;
    estilosMusicais: string[];
    formacao: string;
    somDisponivel: boolean;
    status: EventStatus;
    confirmacaoMusico: boolean;
    confirmacaoContratante: boolean;
  };
  contratante: { nome: string; telefone: string; fotoPerfilUrl: string } | null;
  musico: { nome: string; telefone: string; fotoPerfilUrl: string } | null;
  pagamento: { cache: number; comissao: number; total: number; status: PaymentStatus; repasseStatus: PayoutStatus | null; refundStatus: "PROCESSANDO" | "NEGADO" | "CONFIRMADO" | null; multaDescontada: number } | null;
  avaliou: boolean;
  contestacao: { motivo: string; abertaPorMim: boolean; status: "ABERTA" | "AGUARDANDO_ESTORNO" } | null;
  contestacaoResolvida: { status: "RESOLVIDA"; decisao: "PAGAR_MUSICO" | "DEVOLVER_CONTRATANTE"; resolvidaEm: string | null } | null;
  podeContestar: boolean;
  naoComparecimento: { permitido: boolean };
  ausencia: { informadaEm: string; prazo: string } | null;
  cancelamento: { permitido: boolean; reembolso: boolean };
}

export type EstadoDaAutorizacaoDePush = "PENDENTE" | "REGISTRADA" | "CANCELADA" | "REVOGADA" | "EXPIRADA";
export type EstadoEsperadoDoVinculo = "AUSENTE" | "LEGADO" | "VINCULADO";

export interface AutorizacaoDePush {
  operationId: string;
  vinculoId: string;
  estadoEsperado: EstadoEsperadoDoVinculo;
  estado: EstadoDaAutorizacaoDePush;
  expiraEm: string;
  resultado: "EMITIDA" | "JA_EMITIDA" | "TERMINAL";
}

export interface RegistroDePush {
  vinculoId: string;
  resultado: "REGISTRADO" | "JA_REGISTRADO";
}

export interface EncerramentoDePush {
  estado: EstadoDaAutorizacaoDePush | null;
  resultado: "CANCELADA" | "CANCELADA_SEM_EMISSAO" | "REVOGADA" | "JA_ENCERRADA" | "DESCONHECIDA" | "NEGADA" | "REMOVIDO" | "INEXISTENTE" | "COM_COMPROVANTE";
}
