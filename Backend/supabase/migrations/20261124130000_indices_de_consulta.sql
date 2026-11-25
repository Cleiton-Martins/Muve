-- Índices para as consultas que a API repete a cada requisição ou a cada
-- execução da rotina financeira. Nenhum muda regra; só evitam varredura
-- completa à medida que payments e events crescem.
--
-- Esta migration não foi aplicada em nenhum banco; a aplicação é uma etapa
-- separada, depois da conferência pelo responsável.

-- findLatestPayment (supabaseMarket.ts): where event_id = ? order by created_at desc limit 1.
-- Os índices parciais existentes só cobrem status PENDENTE e PAGO; esta consulta
-- também encontra ESTORNADO, CANCELADO e EXPIRADO.
create index payments_por_evento_recente_idx on public.payments (event_id, created_at desc);

-- findFinanceFollowUps, a cada 5 minutos pela rotina:
--   status = 'PENDENTE' and expira_em <= now()      -> cobranças vencidas
--   refund_status = 'PROCESSANDO'                  -> estornos em acompanhamento
--   status = 'PAGO' and repasse_status in (...)    -> repasses a pedir ou acompanhar
-- Índices parciais: pequenos, porque só guardam as linhas em andamento.
create index payments_pendentes_vencendo_idx on public.payments (expira_em) where status = 'PENDENTE';
create index payments_estorno_em_processamento_idx on public.payments (event_id) where refund_status = 'PROCESSANDO';
create index payments_repasse_em_aberto_idx on public.payments (repasse_status, event_id) where status = 'PAGO' and repasse_status in ('RETIDO', 'PROCESSANDO');

-- findDueHirings: status = 'CONTRATADO' and inicio <= ? (conclusão automática em 7 dias).
-- O índice do feed é parcial em ABERTO e não serve aqui.
create index events_contratados_por_inicio_idx on public.events (inicio) where status = 'CONTRATADO';
