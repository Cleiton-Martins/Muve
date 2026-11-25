-- Configuração operacional inicial do vínculo de push (F4), aprovada em 24/11/2026.
-- Não é migration: aplicar uma vez, depois da migration 20261125130000_push_autorizacoes.
-- Idempotente: só preenche valores ainda nulos; valores já ajustados pela operação são preservados.
-- Ajustes futuros: update direto em public.push_parametros e public.push_capacidade (id = 1).
-- A capacidade global é um limite operacional inicial, não garantia de capacidade física ou de escala.
do $$
begin
  insert into public.push_parametros (id) values (1) on conflict (id) do nothing;
  insert into public.push_capacidade (id, utilizadas)
  select 1, count(*) from public.push_autorizacoes
  on conflict (id) do nothing;

  update public.push_parametros
  set validade_segundos = coalesce(validade_segundos, 600),
      janela_segundos = coalesce(janela_segundos, 3600),
      max_emissoes_janela = coalesce(max_emissoes_janela, 20),
      max_pendentes_conta = coalesce(max_pendentes_conta, 5),
      max_total_conta = coalesce(max_total_conta, 1000)
  where id = 1
    and (validade_segundos is null or janela_segundos is null or max_emissoes_janela is null
      or max_pendentes_conta is null or max_total_conta is null);

  update public.push_capacidade
  set limite_total = coalesce(limite_total, 200000),
      reserva_cancelamentos = coalesce(reserva_cancelamentos, 10000)
  where id = 1
    and (limite_total is null or reserva_cancelamentos is null);
end;
$$;

select validade_segundos, janela_segundos, max_emissoes_janela, max_pendentes_conta, max_total_conta
from public.push_parametros where id = 1;
select limite_total, reserva_cancelamentos, utilizadas from public.push_capacidade where id = 1;
