begin;
create extension if not exists pgtap with schema extensions;
select plan(127);

-- Dados sintéticos: três contas, tokens fictícios e comprovantes de 32 bytes gerados aqui.
create function pg_temp.c(p_byte text) returns bytea language sql immutable as $$ select decode(repeat(p_byte, 32), 'hex') $$;
create function pg_temp.ua() returns uuid language sql immutable as $$ select '00000000-0000-0000-0000-00000000f4a1'::uuid $$;
create function pg_temp.ub() returns uuid language sql immutable as $$ select '00000000-0000-0000-0000-00000000f4b1'::uuid $$;
create function pg_temp.uc() returns uuid language sql immutable as $$ select '00000000-0000-0000-0000-00000000f4c1'::uuid $$;
create function pg_temp.op(p_n int) returns uuid language sql immutable as $$ select ('f4000000-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid $$;
create temp table alvos (n int primary key, alvo uuid not null);
grant all on alvos to service_role;

insert into auth.users (id, email) values
  (pg_temp.ua(), 'f4-a@example.com'), (pg_temp.ub(), 'f4-b@example.com'), (pg_temp.uc(), 'f4-c@example.com'), ('00000000-0000-0000-0000-00000000f4d1', 'f4-d@example.com');
insert into public.profiles (id, role) values (pg_temp.ua(), 'MUSICIAN'), (pg_temp.ub(), 'MUSICIAN'), (pg_temp.uc(), 'CONTRACTOR'), ('00000000-0000-0000-0000-00000000f4d1', 'MUSICIAN');

-- 1. Estrutura, donos e privilégios efetivos.
select ok(exists (select 1 from pg_roles where rolname = 'push_autorizacao_executor' and not rolcanlogin and not rolsuper
  and not rolbypassrls and not rolcreaterole and not rolcreatedb and not rolreplication), 'papel dedicado sem login e sem atributos elevados');
select is((select count(*)::int from pg_tables where schemaname = 'public' and tableowner = 'push_autorizacao_executor'
  and tablename in ('push_autorizacoes', 'push_cotas', 'push_capacidade', 'push_parametros')), 4, 'as quatro tabelas novas pertencem ao papel dedicado');
select is((select tableowner::text from pg_tables where schemaname = 'public' and tablename = 'push_tokens'), 'postgres', 'push_tokens continua do postgres');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in ('push_emitir_autorizacao', 'push_registrar_token', 'push_cancelar_operacao', 'push_revogar_por_segredo',
    'push_remover_vinculo_legado', 'push_limpar_token_invalido', 'push_encerrar_expiradas')
  and p.prosecdef and p.proowner = 'push_autorizacao_executor'::regrole and p.proconfig @> array['search_path=""']), 7,
  'as sete funções públicas são SECURITY DEFINER, do papel dedicado e com search_path vazio');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'private' and p.proname like 'push\_%' and p.proowner = 'push_autorizacao_executor'::regrole and p.proconfig @> array['search_path=""']), 8,
  'as oito funções internas são do papel dedicado e com search_path vazio');
select ok(has_table_privilege('service_role', 'public.push_tokens', 'SELECT'), 'service_role lê push_tokens');
select ok(not has_table_privilege('service_role', 'public.push_tokens', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'), 'service_role sem DML direto em push_tokens');
select ok(not exists (select 1 from unnest(array['public.push_autorizacoes', 'public.push_cotas', 'public.push_capacidade', 'public.push_parametros']) t
  where has_table_privilege('service_role', t, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')), 'service_role sem privilégio nas tabelas novas');
select ok(not exists (select 1 from unnest(array['anon', 'authenticated']) r,
  unnest(array['public.push_tokens', 'public.push_autorizacoes', 'public.push_cotas', 'public.push_capacidade', 'public.push_parametros']) t
  where has_table_privilege(r, t, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')), 'anon e authenticated sem privilégio nas cinco tabelas');
select ok(not exists (select 1 from pg_class c, aclexplode(c.relacl) a where c.oid in ('public.push_tokens'::regclass, 'public.push_autorizacoes'::regclass,
  'public.push_cotas'::regclass, 'public.push_capacidade'::regclass, 'public.push_parametros'::regclass) and a.grantee = 0), 'PUBLIC sem privilégio nas cinco tabelas');
select ok((select bool_and(has_function_privilege('service_role', f, 'EXECUTE')) from unnest(array[
  'public.push_emitir_autorizacao(uuid, uuid, text, bytea, text)', 'public.push_registrar_token(uuid, uuid, text, bytea, uuid)',
  'public.push_cancelar_operacao(uuid, uuid, text, bytea)', 'public.push_revogar_por_segredo(uuid, text, bytea)',
  'public.push_remover_vinculo_legado(uuid, text)', 'public.push_limpar_token_invalido(uuid, text)', 'public.push_encerrar_expiradas(integer)']) f),
  'service_role executa as sete funções públicas');
select ok(not exists (select 1 from unnest(array['anon', 'authenticated']) r, pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private') and p.proname like 'push\_%' and has_function_privilege(r, p.oid, 'EXECUTE')), 'anon e authenticated não executam nenhuma função push');
select ok(not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'private' and p.proname like 'push\_%' and has_function_privilege('service_role', p.oid, 'EXECUTE')), 'service_role não executa as funções internas');
select ok(not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
  where n.nspname in ('public', 'private') and p.proname like 'push\_%' and a.grantee = 0), 'PUBLIC não executa nenhuma função push');
select ok((select bool_and(c.relrowsecurity) from pg_class c where c.oid in ('public.push_tokens'::regclass, 'public.push_autorizacoes'::regclass,
  'public.push_cotas'::regclass, 'public.push_capacidade'::regclass, 'public.push_parametros'::regclass)), 'RLS ligado nas cinco tabelas');
select is((select array_agg(p.polname || ':' || array_to_string(p.polroles::regrole[]::text[], ',')) from pg_policy p
  where p.polrelid in ('public.push_tokens'::regclass, 'public.push_autorizacoes'::regclass, 'public.push_cotas'::regclass,
    'public.push_capacidade'::regclass, 'public.push_parametros'::regclass)), array['push_tokens_funcoes:push_autorizacao_executor'],
  'a única política é a de push_tokens, só para o papel dedicado');
select ok(exists (select 1 from pg_constraint where conrelid = 'public.push_autorizacoes'::regclass and contype = 'p'
  and conkey = array[(select attnum from pg_attribute where attrelid = 'public.push_autorizacoes'::regclass and attname = 'operation_id')]::int2[]),
  'operation_id é a chave primária das autorizações');
select ok(exists (select 1 from pg_constraint where conrelid = 'public.push_autorizacoes'::regclass and contype = 'u'
  and conkey = array[(select attnum from pg_attribute where attrelid = 'public.push_autorizacoes'::regclass and attname = 'target_vinculo_id')]::int2[]),
  'target_vinculo_id é único');
select ok(not exists (select 1 from pg_auth_members m where m.roleid = 'push_autorizacao_executor'::regrole and m.member <> 'postgres'::regrole),
  'só o postgres é membro do papel dedicado');
select ok(not has_table_privilege('push_autorizacao_executor', 'public.profiles', 'SELECT,INSERT,UPDATE,DELETE'), 'papel dedicado sem privilégio em profiles');

set local role service_role;
select throws_ok($$ insert into public.push_tokens (token, user_id) values ('ExponentPushToken[direto]', '00000000-0000-0000-0000-00000000f4a1') $$, '42501', null, 'service_role não insere direto em push_tokens');
select throws_ok($$ update public.push_tokens set updated_at = now() $$, '42501', null, 'service_role não altera push_tokens');
select throws_ok($$ delete from public.push_tokens $$, '42501', null, 'service_role não apaga push_tokens');
select throws_ok($$ select * from public.push_autorizacoes $$, '42501', null, 'service_role não lê push_autorizacoes');
select throws_ok($$ update public.push_capacidade set utilizadas = 0 $$, '42501', null, 'service_role não altera o contador global');

-- 2. Falha segura sem parâmetros.
select throws_ok($$ select * from public.push_emitir_autorizacao(pg_temp.ua(), pg_temp.op(1), 'ExponentPushToken[a]', pg_temp.c('a1'), 'CREATE') $$,
  'P0001', 'PUSH_PARAMETROS_AUSENTES', 'sem parâmetros a emissão é recusada');
reset role;
update public.push_parametros set validade_segundos = 600, janela_segundos = 3600, max_emissoes_janela = 50, max_pendentes_conta = 2, max_total_conta = 50;
set local role service_role;
select throws_ok($$ select * from public.push_emitir_autorizacao(pg_temp.ua(), pg_temp.op(1), 'ExponentPushToken[a]', pg_temp.c('a1'), 'CREATE') $$,
  'P0001', 'PUSH_PARAMETROS_AUSENTES', 'sem capacidade global configurada a emissão é recusada');
select throws_ok($$ select * from public.push_cancelar_operacao(pg_temp.ua(), pg_temp.op(1), 'ExponentPushToken[a]', pg_temp.c('a1')) $$,
  'P0001', 'PUSH_PARAMETROS_AUSENTES', 'sem capacidade global configurada o registro terminal é recusado');
reset role;
select is((select count(*)::int from public.push_autorizacoes), 0, 'nenhuma autorização ficou gravada pelas recusas');
update public.push_capacidade set limite_total = 1000, reserva_cancelamentos = 10;
set local role service_role;

-- 3. Emissão CREATE e idempotência.
insert into alvos select 1, target_vinculo_id from public.push_emitir_autorizacao(pg_temp.ua(), pg_temp.op(1), 'ExponentPushToken[a]', pg_temp.c('a1'), 'CREATE');
select results_eq($$ select expected_state, expected_vinculo_id, estado, resultado from public.push_emitir_autorizacao(pg_temp.ua(), pg_temp.op(1), 'ExponentPushToken[a]', pg_temp.c('a1'), 'CREATE') $$,
  $$ values ('AUSENTE'::text, null::uuid, 'PENDENTE'::text, 'JA_EMITIDA'::text) $$, 'repetir a emissão devolve a mesma operação');
select is((select target_vinculo_id from public.push_emitir_autorizacao(pg_temp.ua(), pg_temp.op(1), 'ExponentPushToken[a]', pg_temp.c('a1'), 'CREATE')),
  (select alvo from alvos where n = 1), 'a geração alvo não muda na repetição');
select throws_ok($$ select * from public.push_emitir_autorizacao(pg_temp.ua(), pg_temp.op(1), 'ExponentPushToken[a]', pg_temp.c('a2'), 'CREATE') $$,
  'P0001', 'PUSH_OPERACAO_CONFLITANTE', 'mesma operação com outro comprovante é conflito');
select throws_ok($$ select * from public.push_emitir_autorizacao(pg_temp.ub(), pg_temp.op(1), 'ExponentPushToken[a]', pg_temp.c('a1'), 'CREATE') $$,
  'P0001', 'PUSH_OPERACAO_CONFLITANTE', 'mesma operação por outra conta é conflito');
select throws_ok($$ select * from public.push_emitir_autorizacao(pg_temp.ua(), pg_temp.op(2), 'ExponentPushToken[a]', pg_temp.c('a2'), 'REPLACE') $$,
  'P0001', 'PUSH_INTENCAO_INCOMPATIVEL', 'REPLACE sem vínculo existente é recusado');
select throws_ok($$ select * from public.push_emitir_autorizacao(pg_temp.ua(), pg_temp.op(2), 'token-qualquer', pg_temp.c('a2'), 'CREATE') $$,
  'P0001', 'PUSH_TOKEN_INVALIDO', 'token fora do formato é recusado');
select throws_ok($$ select * from public.push_emitir_autorizacao(pg_temp.ua(), pg_temp.op(2), 'ExponentPushToken[a]', decode(repeat('a2', 31), 'hex'), 'CREATE') $$,
  'P0001', 'PUSH_COMPROVANTE_INVALIDO', 'comprovante com tamanho errado é recusado');
select throws_ok($$ select * from public.push_emitir_autorizacao('00000000-0000-0000-0000-00000000f4ff', pg_temp.op(2), 'ExponentPushToken[z]', pg_temp.c('a2'), 'CREATE') $$,
  'P0001', 'PUSH_CONTA_INEXISTENTE', 'conta inexistente é recusada');
select throws_ok($$ select * from public.push_emitir_autorizacao(pg_temp.ua(), pg_temp.op(2), 'ExponentPushToken[a]', pg_temp.c('a2'), 'OUTRA') $$,
  'P0001', 'PUSH_INTENCAO_INVALIDA', 'intenção desconhecida é recusada');

-- 4. Registro CREATE.
select throws_ok($$ select * from public.push_registrar_token(pg_temp.ua(), pg_temp.op(1), 'ExponentPushToken[a]', pg_temp.c('a1'), gen_random_uuid()) $$,
  'P0001', 'PUSH_AUTORIZACAO_NAO_CONFERE', 'geração alvo diferente da emitida é recusada');
select throws_ok($$ select * from public.push_registrar_token(pg_temp.ua(), pg_temp.op(1), 'ExponentPushToken[a]', pg_temp.c('a9'), (select alvo from alvos where n = 1)) $$,
  'P0001', 'PUSH_AUTORIZACAO_NAO_CONFERE', 'comprovante diferente do emitido é recusado');
select throws_ok($$ select * from public.push_registrar_token(pg_temp.ub(), pg_temp.op(1), 'ExponentPushToken[a]', pg_temp.c('a1'), (select alvo from alvos where n = 1)) $$,
  'P0001', 'PUSH_AUTORIZACAO_NAO_CONFERE', 'outra conta não registra a autorização');
select throws_ok($$ select * from public.push_registrar_token(pg_temp.ua(), pg_temp.op(99), 'ExponentPushToken[a]', pg_temp.c('a1'), (select alvo from alvos where n = 1)) $$,
  'P0001', 'PUSH_AUTORIZACAO_INEXISTENTE', 'registro sem autorização é recusado');
select is((select resultado from public.push_registrar_token(pg_temp.ua(), pg_temp.op(1), 'ExponentPushToken[a]', pg_temp.c('a1'), (select alvo from alvos where n = 1))),
  'REGISTRADO', 'registro com a autorização emitida');
select is((select resultado from public.push_registrar_token(pg_temp.ua(), pg_temp.op(1), 'ExponentPushToken[a]', pg_temp.c('a1'), (select alvo from alvos where n = 1))),
  'JA_REGISTRADO', 'repetir o registro é idempotente');
reset role;
select results_eq($$ select user_id, vinculo_id, operation_id, comprovante from public.push_tokens where token = 'ExponentPushToken[a]' $$,
  $$ select pg_temp.ua(), (select alvo from alvos where n = 1), pg_temp.op(1), pg_temp.c('a1') $$, 'o vínculo guarda geração, operação e comprovante');
select results_eq($$ select emissoes_na_janela, pendentes, total from public.push_cotas where user_id = pg_temp.ua() $$,
  $$ values (1, 0, 1) $$, 'cotas da conta após emitir e registrar');
select is((select utilizadas from public.push_capacidade), 1, 'a reserva global continua ocupada depois do registro');
set local role service_role;
select throws_ok($$ select * from public.push_emitir_autorizacao(pg_temp.ub(), pg_temp.op(2), 'ExponentPushToken[a]', pg_temp.c('b2'), 'CREATE') $$,
  'P0001', 'DISPOSITIVO_EM_OUTRA_CONTA', 'token vinculado a outra conta não é emitido');

-- 5. REPLACE: nova geração; a anterior não volta.
insert into alvos select 3, target_vinculo_id from public.push_emitir_autorizacao(pg_temp.ua(), pg_temp.op(3), 'ExponentPushToken[a]', pg_temp.c('a3'), 'REPLACE');
insert into alvos select 30, target_vinculo_id from public.push_emitir_autorizacao(pg_temp.ua(), pg_temp.op(30), 'ExponentPushToken[a]', pg_temp.c('d0'), 'REPLACE');
reset role;
select results_eq($$ select expected_state, expected_vinculo_id from public.push_autorizacoes where operation_id = pg_temp.op(3) $$,
  $$ select 'VINCULADO'::text, (select alvo from alvos where n = 1) $$, 'REPLACE guarda a geração esperada');
set local role service_role;
select is((select resultado from public.push_registrar_token(pg_temp.ua(), pg_temp.op(3), 'ExponentPushToken[a]', pg_temp.c('a3'), (select alvo from alvos where n = 3))),
  'REGISTRADO', 'REPLACE registrado');
select throws_ok($$ select * from public.push_registrar_token(pg_temp.ua(), pg_temp.op(30), 'ExponentPushToken[a]', pg_temp.c('d0'), (select alvo from alvos where n = 30)) $$,
  'P0001', 'PUSH_ESTADO_DIVERGENTE', 'REPLACE com expected_vinculo_id desatualizado é recusado');
select is((select resultado from public.push_cancelar_operacao(pg_temp.ua(), pg_temp.op(30), 'ExponentPushToken[a]', pg_temp.c('d0'))), 'CANCELADA', 'o REPLACE recusado é cancelado');
select throws_ok($$ select * from public.push_registrar_token(pg_temp.ua(), pg_temp.op(1), 'ExponentPushToken[a]', pg_temp.c('a1'), (select alvo from alvos where n = 1)) $$,
  'P0001', 'PUSH_GERACAO_SUBSTITUIDA', 'a operação anterior não reativa a geração substituída');
select results_eq($$ select estado, resultado from public.push_revogar_por_segredo(pg_temp.op(1), 'ExponentPushToken[a]', pg_temp.c('a1')) $$,
  $$ values ('REVOGADA'::text, 'REVOGADA'::text) $$, 'revogar a operação antiga encerra só ela');
reset role;
select is((select vinculo_id from public.push_tokens where token = 'ExponentPushToken[a]'), (select alvo from alvos where n = 3),
  'revogar a operação antiga não remove a geração nova');
set local role service_role;

-- 6. Revogação por segredo, sem sessão.
select results_eq($$ select estado, resultado from public.push_revogar_por_segredo(pg_temp.op(77), 'ExponentPushToken[a]', pg_temp.c('a3')) $$,
  $$ values (null::text, 'DESCONHECIDA'::text) $$, 'operação desconhecida não é revogada');
select results_eq($$ select estado, resultado from public.push_revogar_por_segredo(pg_temp.op(3), 'ExponentPushToken[a]', pg_temp.c('ff')) $$,
  $$ values (null::text, 'NEGADA'::text) $$, 'comprovante errado é negado');
select results_eq($$ select estado, resultado from public.push_revogar_por_segredo(pg_temp.op(3), 'ExponentPushToken[outro]', pg_temp.c('a3')) $$,
  $$ values (null::text, 'NEGADA'::text) $$, 'token diferente é negado');
reset role;
select ok(not exists (select 1 from public.push_autorizacoes where operation_id = pg_temp.op(77)), 'a revogação não cria autorização');
select ok(exists (select 1 from public.push_tokens where token = 'ExponentPushToken[a]'), 'revogações negadas não removem o vínculo');
set local role service_role;
select results_eq($$ select estado, resultado from public.push_revogar_por_segredo(pg_temp.op(3), 'ExponentPushToken[a]', pg_temp.c('a3')) $$,
  $$ values ('REVOGADA'::text, 'REVOGADA'::text) $$, 'revogação com C correto');
reset role;
select ok(not exists (select 1 from public.push_tokens where token = 'ExponentPushToken[a]'), 'a revogação remove o vínculo da geração');
set local role service_role;
select results_eq($$ select estado, resultado from public.push_revogar_por_segredo(pg_temp.op(3), 'ExponentPushToken[a]', pg_temp.c('a3')) $$,
  $$ values ('REVOGADA'::text, 'JA_ENCERRADA'::text) $$, 'revogar de novo não muda nada');
insert into alvos select 31, target_vinculo_id from public.push_emitir_autorizacao(pg_temp.ua(), pg_temp.op(31), 'ExponentPushToken[a]', pg_temp.c('d1'), 'CREATE');
select results_eq($$ select estado, resultado from public.push_revogar_por_segredo(pg_temp.op(31), 'ExponentPushToken[a]', pg_temp.c('d1')) $$,
  $$ values ('REVOGADA'::text, 'REVOGADA'::text) $$, 'revogação antecipada, antes do registro');
select throws_ok($$ select * from public.push_registrar_token(pg_temp.ua(), pg_temp.op(31), 'ExponentPushToken[a]', pg_temp.c('d1'), (select alvo from alvos where n = 31)) $$,
  'P0001', 'PUSH_AUTORIZACAO_TERMINAL', 'registro depois da revogação antecipada é recusado');

-- 7. Cancelamento autenticado e registro terminal.
select results_eq($$ select estado, resultado from public.push_cancelar_operacao(pg_temp.ua(), pg_temp.op(4), 'ExponentPushToken[b]', pg_temp.c('a4')) $$,
  $$ values ('CANCELADA'::text, 'CANCELADA_SEM_EMISSAO'::text) $$, 'cancelar operação desconhecida cria o registro terminal');
select results_eq($$ select estado, resultado from public.push_emitir_autorizacao(pg_temp.ua(), pg_temp.op(4), 'ExponentPushToken[b]', pg_temp.c('a4'), 'CREATE') $$,
  $$ values ('CANCELADA'::text, 'TERMINAL'::text) $$, 'emissão atrasada não reabre a operação cancelada');
select throws_ok($$ select * from public.push_cancelar_operacao(pg_temp.ub(), pg_temp.op(4), 'ExponentPushToken[b]', pg_temp.c('a4')) $$,
  'P0001', 'PUSH_AUTORIZACAO_NAO_CONFERE', 'outra conta não cancela a operação');
select is((select resultado from public.push_emitir_autorizacao(pg_temp.ua(), pg_temp.op(5), 'ExponentPushToken[b]', pg_temp.c('a5'), 'CREATE')), 'EMITIDA', 'emissão para cancelar');
insert into alvos select 5, target_vinculo_id from public.push_emitir_autorizacao(pg_temp.ua(), pg_temp.op(5), 'ExponentPushToken[b]', pg_temp.c('a5'), 'CREATE');
select results_eq($$ select estado, resultado from public.push_cancelar_operacao(pg_temp.ua(), pg_temp.op(5), 'ExponentPushToken[b]', pg_temp.c('a5')) $$,
  $$ values ('CANCELADA'::text, 'CANCELADA'::text) $$, 'cancelar autorização pendente');
reset role;
select ok(exists (select 1 from public.push_autorizacoes where operation_id = pg_temp.op(5) and estado = 'CANCELADA' and origem = 'EMISSAO'), 'a pendente cancelada vira registro terminal');
select is((select utilizadas from public.push_capacidade), (select count(*)::int from public.push_autorizacoes), 'a reserva da pendente convertida continua contada na capacidade global');
set local role service_role;
select throws_ok($$ select * from public.push_registrar_token(pg_temp.ua(), pg_temp.op(5), 'ExponentPushToken[b]', pg_temp.c('a5'), (select alvo from alvos where n = 5)) $$,
  'P0001', 'PUSH_AUTORIZACAO_TERMINAL', 'autorização cancelada não registra');
insert into alvos select 6, target_vinculo_id from public.push_emitir_autorizacao(pg_temp.ua(), pg_temp.op(6), 'ExponentPushToken[c]', pg_temp.c('a6'), 'CREATE');
select is((select resultado from public.push_registrar_token(pg_temp.ua(), pg_temp.op(6), 'ExponentPushToken[c]', pg_temp.c('a6'), (select alvo from alvos where n = 6))), 'REGISTRADO', 'registro para cancelar');
select results_eq($$ select estado, resultado from public.push_cancelar_operacao(pg_temp.ua(), pg_temp.op(6), 'ExponentPushToken[c]', pg_temp.c('a6')) $$,
  $$ values ('CANCELADA'::text, 'CANCELADA'::text) $$, 'cancelar autorização registrada');
reset role;
select ok(not exists (select 1 from public.push_tokens where token = 'ExponentPushToken[c]'), 'cancelar a registrada remove o vínculo');
select results_eq($$ select origem, intencao, estado from public.push_autorizacoes where operation_id = pg_temp.op(4) $$,
  $$ values ('CANCELAMENTO'::text, null::text, 'CANCELADA'::text) $$, 'registro terminal sem intenção');
select results_eq($$ select pendentes, total from public.push_cotas where user_id = pg_temp.ua() $$, $$ values (0, 7) $$, 'cancelamentos e revogações liberam as pendências; o acumulado conserva todas as operações');

-- 8. Vínculo legado.
insert into public.push_tokens (token, user_id) values ('ExponentPushToken[legado]', pg_temp.ua()), ('ExponentPushToken[legado2]', pg_temp.ua());
select ok(exists (select 1 from public.push_tokens where token = 'ExponentPushToken[legado]' and operation_id is null), 'postgres ainda insere vínculo legado');
select throws_ok($$ insert into public.push_tokens (token, user_id, vinculo_id, operation_id, comprovante) values ('ExponentPushToken[forjado]', '00000000-0000-0000-0000-00000000f4a1', gen_random_uuid(), gen_random_uuid(), decode(repeat('aa', 32), 'hex')) $$,
  '42501', 'PUSH_VINCULO_SO_PELAS_FUNCOES', 'vínculo com comprovante só pelas funções');
set local role service_role;
insert into alvos select 7, target_vinculo_id from public.push_emitir_autorizacao(pg_temp.ua(), pg_temp.op(7), 'ExponentPushToken[legado]', pg_temp.c('a7'), 'ATTACH_LEGACY');
select throws_ok($$ select * from public.push_emitir_autorizacao(pg_temp.ua(), pg_temp.op(8), 'ExponentPushToken[legado]', pg_temp.c('a8'), 'CREATE') $$,
  'P0001', 'PUSH_INTENCAO_INCOMPATIVEL', 'CREATE sobre vínculo legado é recusado');
select is((select resultado from public.push_registrar_token(pg_temp.ua(), pg_temp.op(7), 'ExponentPushToken[legado]', pg_temp.c('a7'), (select alvo from alvos where n = 7))), 'REGISTRADO', 'ATTACH_LEGACY registrado');
select is(public.push_remover_vinculo_legado(pg_temp.ua(), 'ExponentPushToken[legado]'), 'COM_COMPROVANTE', 'vínculo com comprovante não sai pela remoção legada');
select is(public.push_remover_vinculo_legado(pg_temp.ub(), 'ExponentPushToken[legado2]'), 'INEXISTENTE', 'outra conta não remove o legado');
select is(public.push_remover_vinculo_legado(pg_temp.ua(), 'ExponentPushToken[legado2]'), 'REMOVIDO', 'o dono remove o legado');
select is(public.push_limpar_token_invalido(pg_temp.ub(), 'ExponentPushToken[legado]'), 'INEXISTENTE', 'limpeza só do destinatário correto');
select is(public.push_limpar_token_invalido(pg_temp.ua(), 'ExponentPushToken[legado]'), 'REMOVIDO', 'limpeza do token inválido');

-- 9. Cotas por conta.
select is((select resultado from public.push_emitir_autorizacao(pg_temp.ua(), pg_temp.op(10), 'ExponentPushToken[p1]', pg_temp.c('b0'), 'CREATE')), 'EMITIDA', 'primeira pendente');
select is((select resultado from public.push_emitir_autorizacao(pg_temp.ua(), pg_temp.op(11), 'ExponentPushToken[p2]', pg_temp.c('b1'), 'CREATE')), 'EMITIDA', 'segunda pendente');
select throws_ok($$ select * from public.push_emitir_autorizacao(pg_temp.ua(), pg_temp.op(12), 'ExponentPushToken[p3]', pg_temp.c('b2'), 'CREATE') $$,
  'P0001', 'PUSH_PENDENTES_EXCEDIDAS', 'limite de pendentes por conta');
select is((select resultado from public.push_cancelar_operacao(pg_temp.ua(), pg_temp.op(10), 'ExponentPushToken[p1]', pg_temp.c('b0'))), 'CANCELADA', 'cancelar libera uma pendente');
reset role;
update public.push_parametros set max_emissoes_janela = (select emissoes_na_janela from public.push_cotas where user_id = pg_temp.ua());
set local role service_role;
select throws_ok($$ select * from public.push_emitir_autorizacao(pg_temp.ua(), pg_temp.op(12), 'ExponentPushToken[p3]', pg_temp.c('b2'), 'CREATE') $$,
  'P0001', 'PUSH_FREQUENCIA_EXCEDIDA', 'limite de frequência por conta');
reset role;
update public.push_cotas set janela_inicio = now() - interval '2 hours' where user_id = pg_temp.ua();
set local role service_role;
select is((select resultado from public.push_emitir_autorizacao(pg_temp.ua(), pg_temp.op(12), 'ExponentPushToken[p3]', pg_temp.c('b2'), 'CREATE')), 'EMITIDA', 'a janela vencida reinicia a frequência');
reset role;
update public.push_parametros set max_emissoes_janela = 50, max_pendentes_conta = 10, max_total_conta = (select total from public.push_cotas where user_id = pg_temp.ua());
set local role service_role;
select throws_ok($$ select * from public.push_emitir_autorizacao(pg_temp.ua(), pg_temp.op(13), 'ExponentPushToken[p4]', pg_temp.c('b3'), 'CREATE') $$,
  'P0001', 'PUSH_LIMITE_DA_CONTA', 'limite acumulado por conta na emissão');
select throws_ok($$ select * from public.push_cancelar_operacao(pg_temp.ua(), pg_temp.op(13), 'ExponentPushToken[p4]', pg_temp.c('b3')) $$,
  'P0001', 'PUSH_LIMITE_DA_CONTA', 'limite acumulado por conta no registro terminal');
select is((select resultado from public.push_cancelar_operacao(pg_temp.ua(), pg_temp.op(11), 'ExponentPushToken[p2]', pg_temp.c('b1'))), 'CANCELADA',
  'cancelar operação existente funciona com o limite acumulado esgotado');
select results_eq($$ select estado, resultado from public.push_revogar_por_segredo(pg_temp.op(12), 'ExponentPushToken[p3]', pg_temp.c('b2')) $$,
  $$ values ('REVOGADA'::text, 'REVOGADA'::text) $$, 'revogação funciona com as cotas de emissão esgotadas');
reset role;
update public.push_parametros set max_total_conta = 50;

-- 10. Capacidade global com reserva para cancelamentos.
select is((select utilizadas from public.push_capacidade), (select count(*)::int from public.push_autorizacoes), 'contador global igual ao total de autorizações');
update public.push_capacidade set reserva_cancelamentos = 2, limite_total = (select count(*)::int from public.push_autorizacoes) + 3;
set local role service_role;
select is((select resultado from public.push_emitir_autorizacao(pg_temp.uc(), pg_temp.op(20), 'ExponentPushToken[g1]', pg_temp.c('c0'), 'CREATE')), 'EMITIDA', 'emissão dentro da capacidade livre');
select throws_ok($$ select * from public.push_emitir_autorizacao(pg_temp.uc(), pg_temp.op(21), 'ExponentPushToken[g2]', pg_temp.c('c1'), 'CREATE') $$,
  'P0001', 'PUSH_CAPACIDADE_ESGOTADA', 'emissão não usa a reserva de cancelamentos');
select is((select resultado from public.push_cancelar_operacao(pg_temp.uc(), pg_temp.op(21), 'ExponentPushToken[g2]', pg_temp.c('c1'))), 'CANCELADA_SEM_EMISSAO', 'registro terminal usa a reserva');
select is((select resultado from public.push_cancelar_operacao(pg_temp.uc(), pg_temp.op(22), 'ExponentPushToken[g3]', pg_temp.c('c2'))), 'CANCELADA_SEM_EMISSAO', 'segundo registro terminal usa a reserva');
select throws_ok($$ select * from public.push_cancelar_operacao(pg_temp.uc(), pg_temp.op(23), 'ExponentPushToken[g4]', pg_temp.c('c3')) $$,
  'P0001', 'PUSH_CAPACIDADE_ESGOTADA', 'a reserva também tem limite');
reset role;
select is((select utilizadas from public.push_capacidade), (select count(*)::int from public.push_autorizacoes), 'contador global consistente após as recusas');
update public.push_capacidade set limite_total = 1000, reserva_cancelamentos = 10;

-- 11. Expiração.
alter table public.push_autorizacoes disable trigger push_autorizacoes_protecao;
update public.push_autorizacoes set expira_em = now() - interval '1 second' where operation_id = pg_temp.op(20);
alter table public.push_autorizacoes enable trigger push_autorizacoes_protecao;
set local role service_role;
select throws_ok($$ select * from public.push_registrar_token(pg_temp.uc(), pg_temp.op(20), 'ExponentPushToken[g1]', pg_temp.c('c0'), gen_random_uuid()) $$,
  'P0001', 'PUSH_AUTORIZACAO_NAO_CONFERE', 'registro vencido com geração errada continua recusado');
select throws_ok(format($$ select * from public.push_registrar_token(%L, %L, 'ExponentPushToken[g1]', %L, %L) $$, pg_temp.uc(), pg_temp.op(20), pg_temp.c('c0'),
  (select target_vinculo_id from public.push_emitir_autorizacao(pg_temp.uc(), pg_temp.op(20), 'ExponentPushToken[g1]', pg_temp.c('c0'), 'CREATE'))),
  'P0001', 'PUSH_AUTORIZACAO_EXPIRADA', 'autorização vencida não registra');
select is(public.push_encerrar_expiradas(10), 1, 'encerra a pendente vencida');
select is(public.push_encerrar_expiradas(10), 0, 'nada a encerrar na segunda passada');
select throws_ok($$ select public.push_encerrar_expiradas(0) $$, 'P0001', 'PUSH_PARAMETRO_INVALIDO', 'limite de lote inválido');
reset role;
select results_eq($$ select estado from public.push_autorizacoes where operation_id = pg_temp.op(20) $$, $$ values ('EXPIRADA'::text) $$, 'estado EXPIRADA');
select is((select pendentes from public.push_cotas where user_id = pg_temp.uc()), 0, 'expiração libera a pendência');

-- 12. Imutabilidade contra DML direto, inclusive do postgres e do próprio papel.
select throws_ok($$ update public.push_autorizacoes set estado = 'REGISTRADA', registrada_em = now() where operation_id = 'f4000000-0000-4000-8000-000000000012' $$,
  '42501', 'PUSH_AUTORIZACAO_SO_PELAS_FUNCOES', 'postgres não muda autorização');
select throws_ok($$ delete from public.push_autorizacoes where operation_id = 'f4000000-0000-4000-8000-000000000004' $$,
  '42501', 'PUSH_AUTORIZACAO_SO_SAI_COM_A_CONTA', 'registro terminal não é apagado direto');
insert into public.push_tokens (token, user_id) values ('ExponentPushToken[legadoC]', pg_temp.uc());
select throws_ok($$ update public.push_tokens set user_id = '00000000-0000-0000-0000-00000000f4b1' where token = 'ExponentPushToken[legadoC]' $$,
  '42501', 'PUSH_TOKEN_E_DONO_IMUTAVEIS', 'token e dono do vínculo não mudam');
select throws_ok($$ delete from public.push_tokens where token = 'ExponentPushToken[legadoC]' $$,
  '42501', 'PUSH_VINCULO_SO_PELAS_FUNCOES', 'postgres não apaga vínculo direto');
-- O papel dedicado não enxerga o pgTAP (sem USAGE em extensions); o erro é capturado num bloco e conferido depois.
set local role push_autorizacao_executor;
do $$ begin
  update public.push_autorizacoes set estado = 'PENDENTE', encerrada_em = null where operation_id = 'f4000000-0000-4000-8000-000000000004';
  perform set_config('f4.erro_terminal', 'nenhum', true);
exception when others then perform set_config('f4.erro_terminal', sqlstate || ':' || sqlerrm, true);
end $$;
do $$ begin
  update public.push_autorizacoes set comprovante = decode(repeat('00', 32), 'hex') where operation_id = 'f4000000-0000-4000-8000-000000000012';
  perform set_config('f4.erro_imutavel', 'nenhum', true);
exception when others then perform set_config('f4.erro_imutavel', sqlstate || ':' || sqlerrm, true);
end $$;
reset role;
select is(current_setting('f4.erro_terminal'), '42501:PUSH_AUTORIZACAO_TERMINAL', 'estado terminal é irreversível, inclusive para o papel dedicado');
select is(current_setting('f4.erro_imutavel'), '42501:PUSH_AUTORIZACAO_IMUTAVEL', 'comprovante e geração não mudam, inclusive para o papel dedicado');

-- 13. Exclusão da conta em cascata e contador global (gatilhos de linha adiados, aplicados aqui na hora).
set local role service_role;
select is((select resultado from public.push_emitir_autorizacao('00000000-0000-0000-0000-00000000f4d1', pg_temp.op(90), 'ExponentPushToken[d]', pg_temp.c('e0'), 'CREATE')), 'EMITIDA', 'conta D com uma autorização');
reset role;
set constraints public.push_autorizacoes_conta_inclusao, public.push_autorizacoes_conta_exclusao immediate;
select is((select count(*)::int from public.push_autorizacoes where user_id = pg_temp.ub()), 0, 'conta B sem autorizações');
delete from auth.users where id = pg_temp.ub();
select is((select utilizadas from public.push_capacidade), (select count(*)::int from public.push_autorizacoes), 'exclusão de conta sem autorizações não muda o contador');
delete from auth.users where id = '00000000-0000-0000-0000-00000000f4d1';
select is((select utilizadas from public.push_capacidade), (select count(*)::int from public.push_autorizacoes), 'exclusão de conta com uma autorização desconta uma vez');
select cmp_ok((select count(*)::int from public.push_autorizacoes where user_id = pg_temp.uc()), '>', 1, 'conta C tem várias autorizações');
savepoint antes_da_exclusao;
delete from auth.users where id = pg_temp.uc();
select is((select utilizadas from public.push_capacidade), (select count(*)::int from public.push_autorizacoes), 'contador acompanha a exclusão de conta com várias autorizações');
rollback to savepoint antes_da_exclusao;
select ok(exists (select 1 from public.push_autorizacoes where user_id = pg_temp.uc()) and (select utilizadas from public.push_capacidade) = (select count(*)::int from public.push_autorizacoes),
  'exclusão desfeita restaura as linhas e o contador');
delete from auth.users where id = pg_temp.ua();
select ok(not exists (select 1 from public.push_tokens where user_id = pg_temp.ua())
  and not exists (select 1 from public.push_autorizacoes where user_id = pg_temp.ua())
  and not exists (select 1 from public.push_cotas where user_id = pg_temp.ua()), 'a exclusão da conta leva vínculos, autorizações, registros terminais e cotas');
select is((select utilizadas from public.push_capacidade), (select count(*)::int from public.push_autorizacoes), 'contador global acompanha a exclusão em cascata');
select ok(exists (select 1 from public.push_autorizacoes where user_id = pg_temp.uc()), 'as autorizações das outras contas continuam');

select * from finish();
rollback;
