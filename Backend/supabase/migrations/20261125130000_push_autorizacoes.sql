-- F4: autorização persistida para vínculo de dispositivos push.
-- Uma linha por operação (operation_id) guarda conta, fingerprint do token, compromisso C,
-- intenção, estado e geração esperados e a geração alvo, gerada só pelo servidor.
-- A escrita em push_tokens passa a acontecer só pelas funções abaixo; a service_role
-- perde o DML direto na mesma migration, para não haver janela com backend antigo gravando
-- vínculos sem comprovante.
-- Ordem de travas em todas as funções (a mesma da exclusão de conta em cascata):
-- advisory do token -> conta (pela FK, na primeira gravação) -> push_tokens -> push_autorizacoes
-- -> push_cotas -> push_capacidade. O contador global é ajustado por gatilhos de linha adiados
-- para o commit.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'push_autorizacao_executor') then
    create role push_autorizacao_executor nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  end if;
end;
$$;

grant push_autorizacao_executor to postgres;
grant usage on schema public, private to push_autorizacao_executor;

-- push_tokens: geração e comprovante; linhas legadas ganham uma geração própria.
alter table public.push_tokens
  add column vinculo_id uuid,
  add column operation_id uuid,
  add column comprovante bytea;

update public.push_tokens set vinculo_id = gen_random_uuid() where vinculo_id is null;

alter table public.push_tokens
  alter column vinculo_id set not null,
  alter column vinculo_id set default gen_random_uuid(),
  add constraint push_tokens_vinculo_unico unique (vinculo_id),
  add constraint push_tokens_comprovante_completo check ((operation_id is null) = (comprovante is null)),
  add constraint push_tokens_comprovante_tamanho check (comprovante is null or octet_length(comprovante) = 32);

create unique index push_tokens_operacao_unica on public.push_tokens (operation_id) where operation_id is not null;

create table public.push_parametros (
  id smallint primary key default 1 check (id = 1),
  validade_segundos integer check (validade_segundos > 0),
  janela_segundos integer check (janela_segundos > 0),
  max_emissoes_janela integer check (max_emissoes_janela > 0),
  max_pendentes_conta integer check (max_pendentes_conta > 0),
  max_total_conta integer check (max_total_conta > 0)
);
insert into public.push_parametros (id) values (1);

create table public.push_capacidade (
  id smallint primary key default 1 check (id = 1),
  limite_total integer check (limite_total > 0),
  reserva_cancelamentos integer check (reserva_cancelamentos >= 0),
  utilizadas integer not null default 0 check (utilizadas >= 0),
  check (limite_total is null or reserva_cancelamentos is null or reserva_cancelamentos < limite_total)
);

create table public.push_autorizacoes (
  operation_id uuid primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  token_fingerprint bytea not null check (octet_length(token_fingerprint) = 32),
  comprovante bytea not null check (octet_length(comprovante) = 32),
  origem text not null check (origem in ('EMISSAO', 'CANCELAMENTO')),
  intencao text check (intencao in ('CREATE', 'ATTACH_LEGACY', 'REPLACE')),
  expected_state text check (expected_state in ('AUSENTE', 'LEGADO', 'VINCULADO')),
  expected_vinculo_id uuid,
  target_vinculo_id uuid not null,
  estado text not null check (estado in ('PENDENTE', 'REGISTRADA', 'CANCELADA', 'REVOGADA', 'EXPIRADA')),
  criada_em timestamptz not null default now(),
  expira_em timestamptz not null,
  registrada_em timestamptz,
  encerrada_em timestamptz,
  constraint push_autorizacoes_alvo_unico unique (target_vinculo_id),
  constraint push_autorizacoes_vinculo_ref unique (operation_id, target_vinculo_id, user_id, comprovante),
  constraint push_autorizacoes_coerencia check (
    (origem = 'EMISSAO'
      and intencao is not null and expected_state is not null
      and (expected_state = 'AUSENTE') = (expected_vinculo_id is null)
      and (intencao = 'CREATE') = (expected_state = 'AUSENTE')
      and (intencao = 'ATTACH_LEGACY') = (expected_state = 'LEGADO')
      and (intencao = 'REPLACE') = (expected_state = 'VINCULADO'))
    or (origem = 'CANCELAMENTO'
      and intencao is null and expected_state is null and expected_vinculo_id is null
      and estado = 'CANCELADA' and registrada_em is null)
  ),
  constraint push_autorizacoes_encerramento check ((estado in ('CANCELADA', 'REVOGADA', 'EXPIRADA')) = (encerrada_em is not null)),
  constraint push_autorizacoes_registro check (estado <> 'REGISTRADA' or registrada_em is not null)
);

create index push_autorizacoes_user_idx on public.push_autorizacoes (user_id);
create index push_autorizacoes_token_idx on public.push_autorizacoes (token_fingerprint);
create index push_autorizacoes_pendentes_idx on public.push_autorizacoes (expira_em) where estado = 'PENDENTE';

create table public.push_cotas (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  janela_inicio timestamptz not null default now(),
  emissoes_na_janela integer not null default 0 check (emissoes_na_janela >= 0),
  pendentes integer not null default 0 check (pendentes >= 0),
  total integer not null default 0 check (total >= 0)
);

alter table public.push_tokens
  add constraint push_tokens_autorizacao_fk
  foreign key (operation_id, vinculo_id, user_id, comprovante)
  references public.push_autorizacoes (operation_id, target_vinculo_id, user_id, comprovante)
  on delete cascade;

-- Contador global: um gatilho de linha adiado para o commit, também nas exclusões em cascata.
insert into public.push_capacidade (id, utilizadas) select 1, count(*) from public.push_autorizacoes;

create function private.push_ajustar_capacidade()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.push_capacidade
  set utilizadas = utilizadas + case when tg_op = 'INSERT' then 1 else -1 end
  where id = 1;
  if not found then raise exception 'PUSH_CAPACIDADE_AUSENTE'; end if;
  return null;
end;
$$;

create constraint trigger push_autorizacoes_conta_inclusao
  after insert on public.push_autorizacoes
  deferrable initially deferred
  for each row execute function private.push_ajustar_capacidade();

create constraint trigger push_autorizacoes_conta_exclusao
  after delete on public.push_autorizacoes
  deferrable initially deferred
  for each row execute function private.push_ajustar_capacidade();

-- Proteção do conteúdo contra DML direto: só o papel dedicado (dono das funções) altera
-- comprovante, operação e geração; token e proprietário nunca mudam.
create function private.push_proteger_vinculo()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.operation_id is not null and current_user <> 'push_autorizacao_executor' then
      raise exception 'PUSH_VINCULO_SO_PELAS_FUNCOES' using errcode = '42501';
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    if current_user <> 'push_autorizacao_executor' and pg_trigger_depth() < 2 then
      raise exception 'PUSH_VINCULO_SO_PELAS_FUNCOES' using errcode = '42501';
    end if;
    return old;
  end if;
  if new.token is distinct from old.token or new.user_id is distinct from old.user_id then
    raise exception 'PUSH_TOKEN_E_DONO_IMUTAVEIS' using errcode = '42501';
  end if;
  if current_user <> 'push_autorizacao_executor' then
    raise exception 'PUSH_VINCULO_SO_PELAS_FUNCOES' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger push_tokens_protecao
  before insert or update or delete on public.push_tokens
  for each row execute function private.push_proteger_vinculo();

create function private.push_proteger_autorizacao()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if pg_trigger_depth() < 2 then
      raise exception 'PUSH_AUTORIZACAO_SO_SAI_COM_A_CONTA' using errcode = '42501';
    end if;
    return old;
  end if;
  if current_user <> 'push_autorizacao_executor' then
    raise exception 'PUSH_AUTORIZACAO_SO_PELAS_FUNCOES' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then return new; end if;
  if new.operation_id is distinct from old.operation_id
    or new.user_id is distinct from old.user_id
    or new.token_fingerprint is distinct from old.token_fingerprint
    or new.comprovante is distinct from old.comprovante
    or new.origem is distinct from old.origem
    or new.intencao is distinct from old.intencao
    or new.expected_state is distinct from old.expected_state
    or new.expected_vinculo_id is distinct from old.expected_vinculo_id
    or new.target_vinculo_id is distinct from old.target_vinculo_id
    or new.criada_em is distinct from old.criada_em
    or new.expira_em is distinct from old.expira_em then
    raise exception 'PUSH_AUTORIZACAO_IMUTAVEL' using errcode = '42501';
  end if;
  if old.estado in ('CANCELADA', 'REVOGADA', 'EXPIRADA') then
    raise exception 'PUSH_AUTORIZACAO_TERMINAL' using errcode = '42501';
  end if;
  if not (
    (old.estado = 'PENDENTE' and new.estado in ('PENDENTE', 'REGISTRADA', 'CANCELADA', 'REVOGADA', 'EXPIRADA'))
    or (old.estado = 'REGISTRADA' and new.estado in ('REGISTRADA', 'CANCELADA', 'REVOGADA'))
  ) then
    raise exception 'PUSH_TRANSICAO_INVALIDA' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger push_autorizacoes_protecao
  before insert or update or delete on public.push_autorizacoes
  for each row execute function private.push_proteger_autorizacao();

-- Funções internas.
create function private.push_exigir_read_committed()
returns void
language plpgsql
set search_path = ''
as $$
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'PUSH_ISOLAMENTO_NAO_SUPORTADO';
  end if;
end;
$$;

create function private.push_fingerprint(p_token text)
returns bytea
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_token is null or p_token !~ '^Expo(nent)?PushToken\[.+\]$' or octet_length(convert_to(p_token, 'UTF8')) > 65535 then
    raise exception 'PUSH_TOKEN_INVALIDO';
  end if;
  return pg_catalog.sha256(convert_to(p_token, 'UTF8'));
end;
$$;

create function private.push_travar_token(p_fingerprint bytea)
returns void
language sql
set search_path = ''
as $$
  select pg_catalog.pg_advisory_xact_lock(('x' || substr(encode(p_fingerprint, 'hex'), 1, 16))::bit(64)::bigint);
$$;

create function private.push_exigir_comprovante(p_comprovante bytea)
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_comprovante is null or octet_length(p_comprovante) <> 32 then
    raise exception 'PUSH_COMPROVANTE_INVALIDO';
  end if;
end;
$$;

create function private.push_cotas_da_conta(p_user_id uuid)
returns public.push_cotas
language plpgsql
set search_path = ''
as $$
declare
  v_cotas public.push_cotas;
begin
  insert into public.push_cotas (user_id) values (p_user_id) on conflict (user_id) do nothing;
  select * into v_cotas from public.push_cotas where user_id = p_user_id for update;
  if not found then raise exception 'PUSH_CONTA_INEXISTENTE'; end if;
  return v_cotas;
end;
$$;

-- Reservar capacidade, chamada logo depois de gravar a autorização: trava a linha global, aplica
-- os ajustes adiados pendentes desta transação (o valor passa a incluir a linha nova) e confere o
-- limite para emissões (sem usar a reserva de cancelamentos) ou para cancelamentos (podendo usá-la).
create function private.push_reservar_capacidade(p_para_cancelamento boolean)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_capacidade public.push_capacidade;
begin
  select * into v_capacidade from public.push_capacidade where id = 1 for update;
  if not found or v_capacidade.limite_total is null or v_capacidade.reserva_cancelamentos is null then
    raise exception 'PUSH_PARAMETROS_AUSENTES';
  end if;
  set constraints public.push_autorizacoes_conta_inclusao, public.push_autorizacoes_conta_exclusao immediate;
  set constraints public.push_autorizacoes_conta_inclusao, public.push_autorizacoes_conta_exclusao deferred;
  select * into v_capacidade from public.push_capacidade where id = 1;
  if v_capacidade.utilizadas > v_capacidade.limite_total - (case when p_para_cancelamento then 0 else v_capacidade.reserva_cancelamentos end) then
    raise exception 'PUSH_CAPACIDADE_ESGOTADA';
  end if;
end;
$$;

-- Liberar ou converter reserva: tira a operação do estado pendente da conta.
create function private.push_liberar_pendencia(p_user_id uuid)
returns void
language sql
set search_path = ''
as $$
  update public.push_cotas set pendentes = greatest(pendentes - 1, 0) where user_id = p_user_id;
$$;

-- Emitir autorização.
create function public.push_emitir_autorizacao(p_user_id uuid, p_operation_id uuid, p_token text, p_comprovante bytea, p_intencao text)
returns table (operation_id uuid, target_vinculo_id uuid, expected_state text, expected_vinculo_id uuid, estado text, expira_em timestamptz, resultado text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_fingerprint bytea;
  v_existente public.push_autorizacoes;
  v_vinculo public.push_tokens;
  v_estado_esperado text;
  v_parametros public.push_parametros;
  v_cotas public.push_cotas;
  v_nova public.push_autorizacoes;
begin
  perform private.push_exigir_read_committed();
  if p_user_id is null or p_operation_id is null then raise exception 'PUSH_PARAMETRO_INVALIDO'; end if;
  if p_intencao is null or p_intencao not in ('CREATE', 'ATTACH_LEGACY', 'REPLACE') then raise exception 'PUSH_INTENCAO_INVALIDA'; end if;
  perform private.push_exigir_comprovante(p_comprovante);
  v_fingerprint := private.push_fingerprint(p_token);
  perform private.push_travar_token(v_fingerprint);

  select * into v_existente from public.push_autorizacoes a where a.operation_id = p_operation_id;
  if found then
    if v_existente.user_id <> p_user_id or v_existente.token_fingerprint <> v_fingerprint
      or v_existente.comprovante <> p_comprovante or (v_existente.origem = 'EMISSAO' and v_existente.intencao is distinct from p_intencao) then
      raise exception 'PUSH_OPERACAO_CONFLITANTE';
    end if;
    return query select v_existente.operation_id, v_existente.target_vinculo_id, v_existente.expected_state, v_existente.expected_vinculo_id,
      v_existente.estado, v_existente.expira_em,
      case when v_existente.estado in ('CANCELADA', 'REVOGADA', 'EXPIRADA') then 'TERMINAL' else 'JA_EMITIDA' end;
    return;
  end if;

  select * into v_parametros from public.push_parametros where id = 1;
  if not found or v_parametros.validade_segundos is null or v_parametros.janela_segundos is null
    or v_parametros.max_emissoes_janela is null or v_parametros.max_pendentes_conta is null or v_parametros.max_total_conta is null then
    raise exception 'PUSH_PARAMETROS_AUSENTES';
  end if;

  select * into v_vinculo from public.push_tokens t where t.token = p_token;
  if not found then
    v_estado_esperado := 'AUSENTE';
  elsif v_vinculo.user_id <> p_user_id then
    raise exception 'DISPOSITIVO_EM_OUTRA_CONTA';
  elsif v_vinculo.operation_id is null then
    v_estado_esperado := 'LEGADO';
  else
    v_estado_esperado := 'VINCULADO';
  end if;
  if (p_intencao = 'CREATE') <> (v_estado_esperado = 'AUSENTE')
    or (p_intencao = 'ATTACH_LEGACY') <> (v_estado_esperado = 'LEGADO')
    or (p_intencao = 'REPLACE') <> (v_estado_esperado = 'VINCULADO') then
    raise exception 'PUSH_INTENCAO_INCOMPATIVEL';
  end if;

  begin
    insert into public.push_autorizacoes (operation_id, user_id, token_fingerprint, comprovante, origem, intencao, expected_state,
      expected_vinculo_id, target_vinculo_id, estado, expira_em)
    values (p_operation_id, p_user_id, v_fingerprint, p_comprovante, 'EMISSAO', p_intencao, v_estado_esperado,
      case when v_estado_esperado = 'AUSENTE' then null else v_vinculo.vinculo_id end, gen_random_uuid(), 'PENDENTE',
      now() + make_interval(secs => v_parametros.validade_segundos))
    returning * into v_nova;
  exception
    when foreign_key_violation then raise exception 'PUSH_CONTA_INEXISTENTE';
    when unique_violation then raise exception 'PUSH_OPERACAO_CONFLITANTE';
  end;

  v_cotas := private.push_cotas_da_conta(p_user_id);
  if now() - v_cotas.janela_inicio >= make_interval(secs => v_parametros.janela_segundos) then
    v_cotas.janela_inicio := now();
    v_cotas.emissoes_na_janela := 0;
  end if;
  if v_cotas.emissoes_na_janela + 1 > v_parametros.max_emissoes_janela then raise exception 'PUSH_FREQUENCIA_EXCEDIDA'; end if;
  if v_cotas.pendentes + 1 > v_parametros.max_pendentes_conta then raise exception 'PUSH_PENDENTES_EXCEDIDAS'; end if;
  if v_cotas.total + 1 > v_parametros.max_total_conta then raise exception 'PUSH_LIMITE_DA_CONTA'; end if;
  update public.push_cotas
  set janela_inicio = v_cotas.janela_inicio,
      emissoes_na_janela = v_cotas.emissoes_na_janela + 1,
      pendentes = v_cotas.pendentes + 1,
      total = v_cotas.total + 1
  where user_id = p_user_id;

  perform private.push_reservar_capacidade(false);

  return query select v_nova.operation_id, v_nova.target_vinculo_id, v_nova.expected_state, v_nova.expected_vinculo_id,
    v_nova.estado, v_nova.expira_em, 'EMITIDA'::text;
end;
$$;

-- Registrar token (CREATE, ATTACH_LEGACY ou REPLACE), sempre com a autorização e a geração alvo emitidas.
create function public.push_registrar_token(p_user_id uuid, p_operation_id uuid, p_token text, p_comprovante bytea, p_target_vinculo_id uuid)
returns table (vinculo_id uuid, resultado text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_fingerprint bytea;
  v_autorizacao public.push_autorizacoes;
  v_vinculo public.push_tokens;
begin
  perform private.push_exigir_read_committed();
  if p_user_id is null or p_operation_id is null or p_target_vinculo_id is null then raise exception 'PUSH_PARAMETRO_INVALIDO'; end if;
  perform private.push_exigir_comprovante(p_comprovante);
  v_fingerprint := private.push_fingerprint(p_token);
  perform private.push_travar_token(v_fingerprint);

  select * into v_autorizacao from public.push_autorizacoes a where a.operation_id = p_operation_id;
  if not found then raise exception 'PUSH_AUTORIZACAO_INEXISTENTE'; end if;
  if v_autorizacao.user_id <> p_user_id or v_autorizacao.token_fingerprint <> v_fingerprint
    or v_autorizacao.comprovante <> p_comprovante or v_autorizacao.target_vinculo_id <> p_target_vinculo_id
    or v_autorizacao.origem <> 'EMISSAO' then
    raise exception 'PUSH_AUTORIZACAO_NAO_CONFERE';
  end if;
  if v_autorizacao.estado = 'REGISTRADA' then
    select * into v_vinculo from public.push_tokens t where t.token = p_token;
    if found and v_vinculo.vinculo_id = v_autorizacao.target_vinculo_id then
      return query select v_vinculo.vinculo_id, 'JA_REGISTRADO'::text;
      return;
    end if;
    raise exception 'PUSH_GERACAO_SUBSTITUIDA';
  end if;
  if v_autorizacao.estado <> 'PENDENTE' then raise exception 'PUSH_AUTORIZACAO_TERMINAL'; end if;
  if v_autorizacao.expira_em <= now() then raise exception 'PUSH_AUTORIZACAO_EXPIRADA'; end if;

  if v_autorizacao.intencao = 'CREATE' then
    begin
      insert into public.push_tokens (token, user_id, vinculo_id, operation_id, comprovante)
      values (p_token, p_user_id, v_autorizacao.target_vinculo_id, p_operation_id, p_comprovante);
    exception
      when unique_violation then raise exception 'PUSH_ESTADO_DIVERGENTE';
      when foreign_key_violation then raise exception 'PUSH_CONTA_INEXISTENTE';
    end;
  else
    select * into v_vinculo from public.push_tokens t where t.token = p_token for update;
    if not found or v_vinculo.user_id <> p_user_id or v_vinculo.vinculo_id <> v_autorizacao.expected_vinculo_id
      or (v_autorizacao.expected_state = 'LEGADO' and v_vinculo.operation_id is not null)
      or (v_autorizacao.expected_state = 'VINCULADO' and v_vinculo.operation_id is null) then
      raise exception 'PUSH_ESTADO_DIVERGENTE';
    end if;
    update public.push_tokens
    set vinculo_id = v_autorizacao.target_vinculo_id, operation_id = p_operation_id, comprovante = p_comprovante, updated_at = now()
    where token = p_token;
  end if;

  update public.push_autorizacoes a set estado = 'REGISTRADA', registrada_em = now() where a.operation_id = p_operation_id;
  perform private.push_liberar_pendencia(p_user_id);
  return query select v_autorizacao.target_vinculo_id, 'REGISTRADO'::text;
end;
$$;

-- Cancelar operação com sessão autenticada: encerra a existente ou cria o registro terminal.
create function public.push_cancelar_operacao(p_user_id uuid, p_operation_id uuid, p_token text, p_comprovante bytea)
returns table (estado text, resultado text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_fingerprint bytea;
  v_autorizacao public.push_autorizacoes;
  v_vinculo public.push_tokens;
  v_parametros public.push_parametros;
  v_cotas public.push_cotas;
begin
  perform private.push_exigir_read_committed();
  if p_user_id is null or p_operation_id is null then raise exception 'PUSH_PARAMETRO_INVALIDO'; end if;
  perform private.push_exigir_comprovante(p_comprovante);
  v_fingerprint := private.push_fingerprint(p_token);
  perform private.push_travar_token(v_fingerprint);

  select * into v_autorizacao from public.push_autorizacoes a where a.operation_id = p_operation_id;
  if not found then
    begin
      insert into public.push_autorizacoes (operation_id, user_id, token_fingerprint, comprovante, origem, target_vinculo_id, estado, expira_em, encerrada_em)
      values (p_operation_id, p_user_id, v_fingerprint, p_comprovante, 'CANCELAMENTO', gen_random_uuid(), 'CANCELADA', now(), now());
    exception
      when foreign_key_violation then raise exception 'PUSH_CONTA_INEXISTENTE';
      when unique_violation then raise exception 'PUSH_OPERACAO_CONFLITANTE';
    end;
    select * into v_parametros from public.push_parametros where id = 1;
    if not found or v_parametros.max_total_conta is null then raise exception 'PUSH_PARAMETROS_AUSENTES'; end if;
    v_cotas := private.push_cotas_da_conta(p_user_id);
    if v_cotas.total + 1 > v_parametros.max_total_conta then raise exception 'PUSH_LIMITE_DA_CONTA'; end if;
    update public.push_cotas set total = total + 1 where user_id = p_user_id;
    perform private.push_reservar_capacidade(true);
    return query select 'CANCELADA'::text, 'CANCELADA_SEM_EMISSAO'::text;
    return;
  end if;
  if v_autorizacao.user_id <> p_user_id or v_autorizacao.token_fingerprint <> v_fingerprint or v_autorizacao.comprovante <> p_comprovante then
    raise exception 'PUSH_AUTORIZACAO_NAO_CONFERE';
  end if;
  if v_autorizacao.estado in ('CANCELADA', 'REVOGADA', 'EXPIRADA') then
    return query select v_autorizacao.estado, 'JA_ENCERRADA'::text;
    return;
  end if;

  if v_autorizacao.estado = 'REGISTRADA' then
    select * into v_vinculo from public.push_tokens t where t.token = p_token for update;
    if found and v_vinculo.vinculo_id = v_autorizacao.target_vinculo_id then
      delete from public.push_tokens where token = p_token;
    end if;
  end if;
  select * into v_autorizacao from public.push_autorizacoes a where a.operation_id = p_operation_id for update;
  if not found then raise exception 'PUSH_CONTA_INEXISTENTE'; end if; -- a conta foi excluída enquanto esperava a trava
  update public.push_autorizacoes a set estado = 'CANCELADA', encerrada_em = now() where a.operation_id = p_operation_id;
  if v_autorizacao.estado = 'PENDENTE' then
    perform private.push_cotas_da_conta(p_user_id);
    perform private.push_liberar_pendencia(p_user_id);
  end if;
  return query select 'CANCELADA'::text, 'CANCELADA'::text;
end;
$$;

-- Revogar por segredo, sem sessão: o backend recalcula C com token, operation_id e segredo;
-- o banco compara C, fingerprint, geração e estado persistidos. Não cria autorização nova.
create function public.push_revogar_por_segredo(p_operation_id uuid, p_token text, p_comprovante bytea)
returns table (estado text, resultado text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_fingerprint bytea;
  v_autorizacao public.push_autorizacoes;
  v_vinculo public.push_tokens;
begin
  perform private.push_exigir_read_committed();
  if p_operation_id is null then raise exception 'PUSH_PARAMETRO_INVALIDO'; end if;
  perform private.push_exigir_comprovante(p_comprovante);
  v_fingerprint := private.push_fingerprint(p_token);
  perform private.push_travar_token(v_fingerprint);

  select * into v_autorizacao from public.push_autorizacoes a where a.operation_id = p_operation_id;
  if not found then
    return query select null::text, 'DESCONHECIDA'::text;
    return;
  end if;
  if v_autorizacao.token_fingerprint <> v_fingerprint or v_autorizacao.comprovante <> p_comprovante then
    return query select null::text, 'NEGADA'::text;
    return;
  end if;
  if v_autorizacao.estado in ('CANCELADA', 'REVOGADA', 'EXPIRADA') then
    return query select v_autorizacao.estado, 'JA_ENCERRADA'::text;
    return;
  end if;

  if v_autorizacao.estado = 'REGISTRADA' then
    select * into v_vinculo from public.push_tokens t where t.token = p_token for update;
    if found and v_vinculo.vinculo_id = v_autorizacao.target_vinculo_id then
      delete from public.push_tokens where token = p_token;
    end if;
  end if;
  select * into v_autorizacao from public.push_autorizacoes a where a.operation_id = p_operation_id for update;
  if not found then -- a conta foi excluída enquanto esperava a trava
    return query select null::text, 'DESCONHECIDA'::text;
    return;
  end if;
  update public.push_autorizacoes a set estado = 'REVOGADA', encerrada_em = now() where a.operation_id = p_operation_id;
  if v_autorizacao.estado = 'PENDENTE' then
    perform private.push_cotas_da_conta(v_autorizacao.user_id);
    perform private.push_liberar_pendencia(v_autorizacao.user_id);
  end if;
  return query select 'REVOGADA'::text, 'REVOGADA'::text;
end;
$$;

-- Remover vínculo legado (sem comprovante) pelo proprietário.
create function public.push_remover_vinculo_legado(p_user_id uuid, p_token text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_fingerprint bytea;
  v_vinculo public.push_tokens;
begin
  perform private.push_exigir_read_committed();
  if p_user_id is null then raise exception 'PUSH_PARAMETRO_INVALIDO'; end if;
  v_fingerprint := private.push_fingerprint(p_token);
  perform private.push_travar_token(v_fingerprint);
  select * into v_vinculo from public.push_tokens t where t.token = p_token for update;
  if not found or v_vinculo.user_id <> p_user_id then return 'INEXISTENTE'; end if;
  if v_vinculo.operation_id is not null then return 'COM_COMPROVANTE'; end if;
  delete from public.push_tokens where token = p_token;
  return 'REMOVIDO';
end;
$$;

-- Limpar token inválido apontado pela Expo, só do destinatário correto.
create function public.push_limpar_token_invalido(p_user_id uuid, p_token text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_fingerprint bytea;
  v_vinculo public.push_tokens;
begin
  perform private.push_exigir_read_committed();
  if p_user_id is null then raise exception 'PUSH_PARAMETRO_INVALIDO'; end if;
  v_fingerprint := private.push_fingerprint(p_token);
  perform private.push_travar_token(v_fingerprint);
  select * into v_vinculo from public.push_tokens t where t.token = p_token for update;
  if not found or v_vinculo.user_id <> p_user_id then return 'INEXISTENTE'; end if;
  delete from public.push_tokens where token = p_token;
  return 'REMOVIDO';
end;
$$;

-- Encerrar autorizações pendentes vencidas, em ordem determinística de token e operação.
create function public.push_encerrar_expiradas(p_limite integer)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_item record;
  v_encerradas integer := 0;
  v_contas uuid[] := '{}';
begin
  perform private.push_exigir_read_committed();
  if p_limite is null or p_limite < 1 or p_limite > 1000 then raise exception 'PUSH_PARAMETRO_INVALIDO'; end if;
  for v_item in
    select a.operation_id, a.token_fingerprint
    from public.push_autorizacoes a
    where a.estado = 'PENDENTE' and a.expira_em <= now()
    order by a.token_fingerprint, a.operation_id
    limit p_limite
  loop
    perform private.push_travar_token(v_item.token_fingerprint);
  end loop;
  for v_item in
    select a.operation_id, a.user_id
    from public.push_autorizacoes a
    where a.estado = 'PENDENTE' and a.expira_em <= now()
    order by a.token_fingerprint, a.operation_id
    limit p_limite
    for update of a
  loop
    update public.push_autorizacoes a set estado = 'EXPIRADA', encerrada_em = now() where a.operation_id = v_item.operation_id and a.estado = 'PENDENTE';
    if found then
      v_encerradas := v_encerradas + 1;
      v_contas := v_contas || v_item.user_id;
    end if;
  end loop;
  for v_item in
    select u.user_id, count(*)::integer as quantidade
    from unnest(v_contas) as u (user_id)
    group by u.user_id
    order by u.user_id
  loop
    update public.push_cotas c set pendentes = greatest(c.pendentes - v_item.quantidade, 0) where c.user_id = v_item.user_id;
  end loop;
  return v_encerradas;
end;
$$;

-- Propriedade: tabelas novas e funções ficam com o papel dedicado (precisa de CREATE só durante a troca).
grant create on schema public, private to push_autorizacao_executor;
alter table public.push_autorizacoes owner to push_autorizacao_executor;
alter table public.push_cotas owner to push_autorizacao_executor;
alter table public.push_capacidade owner to push_autorizacao_executor;
alter table public.push_parametros owner to push_autorizacao_executor;
alter function private.push_ajustar_capacidade() owner to push_autorizacao_executor;
alter function private.push_exigir_read_committed() owner to push_autorizacao_executor;
alter function private.push_fingerprint(text) owner to push_autorizacao_executor;
alter function private.push_travar_token(bytea) owner to push_autorizacao_executor;
alter function private.push_exigir_comprovante(bytea) owner to push_autorizacao_executor;
alter function private.push_cotas_da_conta(uuid) owner to push_autorizacao_executor;
alter function private.push_reservar_capacidade(boolean) owner to push_autorizacao_executor;
alter function private.push_liberar_pendencia(uuid) owner to push_autorizacao_executor;
alter function public.push_emitir_autorizacao(uuid, uuid, text, bytea, text) owner to push_autorizacao_executor;
alter function public.push_registrar_token(uuid, uuid, text, bytea, uuid) owner to push_autorizacao_executor;
alter function public.push_cancelar_operacao(uuid, uuid, text, bytea) owner to push_autorizacao_executor;
alter function public.push_revogar_por_segredo(uuid, text, bytea) owner to push_autorizacao_executor;
alter function public.push_remover_vinculo_legado(uuid, text) owner to push_autorizacao_executor;
alter function public.push_limpar_token_invalido(uuid, text) owner to push_autorizacao_executor;
alter function public.push_encerrar_expiradas(integer) owner to push_autorizacao_executor;
revoke create on schema public, private from push_autorizacao_executor;

-- RLS: as tabelas novas ficam fechadas (o dono é o papel dedicado); em push_tokens, que continua
-- do postgres, uma política só para o papel dedicado.
alter table public.push_autorizacoes enable row level security;
alter table public.push_cotas enable row level security;
alter table public.push_capacidade enable row level security;
alter table public.push_parametros enable row level security;
create policy push_tokens_funcoes on public.push_tokens for all to push_autorizacao_executor using (true) with check (true);
grant select, insert, update, delete on public.push_tokens to push_autorizacao_executor;

-- Privilégios: a service_role perde o DML direto nas cinco tabelas e só lê push_tokens.
revoke all on public.push_tokens, public.push_autorizacoes, public.push_cotas, public.push_capacidade, public.push_parametros
  from public, anon, authenticated, service_role;
grant select on public.push_tokens to service_role;

revoke execute on function
  private.push_ajustar_capacidade(), private.push_proteger_vinculo(), private.push_proteger_autorizacao(),
  private.push_exigir_read_committed(), private.push_fingerprint(text), private.push_travar_token(bytea),
  private.push_exigir_comprovante(bytea), private.push_cotas_da_conta(uuid), private.push_reservar_capacidade(boolean),
  private.push_liberar_pendencia(uuid)
  from public, anon, authenticated, service_role;

revoke execute on function
  public.push_emitir_autorizacao(uuid, uuid, text, bytea, text), public.push_registrar_token(uuid, uuid, text, bytea, uuid),
  public.push_cancelar_operacao(uuid, uuid, text, bytea), public.push_revogar_por_segredo(uuid, text, bytea),
  public.push_remover_vinculo_legado(uuid, text), public.push_limpar_token_invalido(uuid, text),
  public.push_encerrar_expiradas(integer)
  from public, anon, authenticated;

grant execute on function
  public.push_emitir_autorizacao(uuid, uuid, text, bytea, text), public.push_registrar_token(uuid, uuid, text, bytea, uuid),
  public.push_cancelar_operacao(uuid, uuid, text, bytea), public.push_revogar_por_segredo(uuid, text, bytea),
  public.push_remover_vinculo_legado(uuid, text), public.push_limpar_token_invalido(uuid, text),
  public.push_encerrar_expiradas(integer)
  to service_role;
