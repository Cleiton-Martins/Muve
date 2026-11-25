-- Testes de banco (pgTAP): leitura direta de public.events segue as regras do feed.
begin;
create extension if not exists pgtap with schema extensions;
select plan(11);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000d30a1', 'd3-musico@example.com'),
  ('00000000-0000-0000-0000-0000000d30a2', 'd3-pro@example.com'),
  ('00000000-0000-0000-0000-0000000d30a3', 'd3-penalizado@example.com'),
  ('00000000-0000-0000-0000-0000000d30c1', 'd3-dono@example.com'),
  ('00000000-0000-0000-0000-0000000d30c2', 'd3-outro-contratante@example.com');
insert into public.profiles (id, role) values
  ('00000000-0000-0000-0000-0000000d30a1', 'MUSICIAN'),
  ('00000000-0000-0000-0000-0000000d30a2', 'MUSICIAN'),
  ('00000000-0000-0000-0000-0000000d30a3', 'MUSICIAN'),
  ('00000000-0000-0000-0000-0000000d30c1', 'CONTRACTOR'),
  ('00000000-0000-0000-0000-0000000d30c2', 'CONTRACTOR');
insert into public.musician_profiles (user_id, nome_completo, documento, telefone, foto_perfil_url, estilos_musicais, uf, cidade) values
  ('00000000-0000-0000-0000-0000000d30a1', 'Musico Gratuito', '93000000101', '45999990301', 'https://x/a1.png', '{Rock}', 'PR', 'Cascavel'),
  ('00000000-0000-0000-0000-0000000d30a2', 'Musico Pro', '93000000102', '45999990302', 'https://x/a2.png', '{Rock}', 'PR', 'Cascavel'),
  ('00000000-0000-0000-0000-0000000d30a3', 'Musico Penalizado', '93000000103', '45999990303', 'https://x/a3.png', '{Rock}', 'PR', 'Cascavel');
update public.musician_profiles set pro_ate = now() + interval '30 days' where user_id = '00000000-0000-0000-0000-0000000d30a2';
update public.musician_profiles set visibilidade_reduzida_ate = now() + interval '5 days' where user_id = '00000000-0000-0000-0000-0000000d30a3';
insert into public.contractor_profiles (user_id, nome_fantasia, documento, telefone, foto_perfil_url, uf, cidade) values
  ('00000000-0000-0000-0000-0000000d30c1', 'Bar Dono', '93000000000101', '4532220301', 'https://x/c1.png', 'PR', 'Cascavel'),
  ('00000000-0000-0000-0000-0000000d30c2', 'Bar Vizinho', '93000000000102', '4532220302', 'https://x/c2.png', 'PR', 'Cascavel');

insert into public.events (id, contractor_id, titulo, tipo_evento, inicio, duracao_minutos, uf, cidade, estilos_musicais, cache, imagem_url) values
  ('00000000-0000-0000-0000-0000000d30e1', '00000000-0000-0000-0000-0000000d30c1', 'Rock na cidade', 'Corporativo', now() + interval '6 days', 60, 'PR', 'Cascavel', '{Rock}', 500, 'https://x/e.png'),
  ('00000000-0000-0000-0000-0000000d30e2', '00000000-0000-0000-0000-0000000d30c1', 'Rock a 430 km', 'Corporativo', now() + interval '6 days', 60, 'PR', 'Curitiba', '{Rock}', 500, 'https://x/e.png'),
  ('00000000-0000-0000-0000-0000000d30e3', '00000000-0000-0000-0000-0000000d30c1', 'Pagode na cidade', 'Corporativo', now() + interval '6 days', 60, 'PR', 'Cascavel', '{Pagode}', 500, 'https://x/e.png'),
  ('00000000-0000-0000-0000-0000000d30e4', '00000000-0000-0000-0000-0000000d30c1', 'Rock em acesso antecipado', 'Corporativo', now() + interval '10 days', 60, 'PR', 'Cascavel', '{Rock}', 500, 'https://x/e.png'),
  ('00000000-0000-0000-0000-0000000d30e5', '00000000-0000-0000-0000-0000000d30c1', 'Convite fora do raio', 'Corporativo', now() + interval '6 days', 60, 'PR', 'Curitiba', '{Pagode}', 500, 'https://x/e.png'),
  ('00000000-0000-0000-0000-0000000d30e6', '00000000-0000-0000-0000-0000000d30c1', 'Inscrito fora do raio', 'Corporativo', now() + interval '6 days', 60, 'PR', 'Curitiba', '{Pagode}', 500, 'https://x/e.png'),
  ('00000000-0000-0000-0000-0000000d30e7', '00000000-0000-0000-0000-0000000d30c1', 'Inscricoes encerradas', 'Corporativo', now() + interval '6 days', 60, 'PR', 'Cascavel', '{Rock}', 500, 'https://x/e.png');
update public.events set inscricoes_encerradas = true where id = '00000000-0000-0000-0000-0000000d30e7';
insert into public.event_invites (event_id, musician_id) values ('00000000-0000-0000-0000-0000000d30e5', '00000000-0000-0000-0000-0000000d30a1');
insert into public.event_candidates (id, event_id, musician_id) values
  ('00000000-0000-0000-0000-0000000d30d6', '00000000-0000-0000-0000-0000000d30e6', '00000000-0000-0000-0000-0000000d30a1');

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000d30a1","role":"authenticated"}';

select results_eq(
  $$ select id from public.events where id::text like '00000000-0000-0000-0000-0000000d30e%' order by id $$,
  $$ values ('00000000-0000-0000-0000-0000000d30e1'::uuid), ('00000000-0000-0000-0000-0000000d30e5'::uuid), ('00000000-0000-0000-0000-0000000d30e6'::uuid) $$,
  'músico gratuito lê só o evento do seu feed, o convite e a própria inscrição'
);
select is((select count(*) from public.events where id = '00000000-0000-0000-0000-0000000d30e2'), 0::bigint, 'evento fora do raio não é legível por select direto');
select is((select count(*) from public.events where id = '00000000-0000-0000-0000-0000000d30e3'), 0::bigint, 'evento de estilo fora do perfil não é legível');
select is((select count(*) from public.events where id = '00000000-0000-0000-0000-0000000d30e4'), 0::bigint, 'evento em acesso antecipado do Pro não é legível pelo músico gratuito');
select is((select count(*) from public.events where id = '00000000-0000-0000-0000-0000000d30e7'), 0::bigint, 'evento com inscrições encerradas não é legível por quem não participa');

set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000d30a2","role":"authenticated"}';
select is((select count(*) from public.events where id = '00000000-0000-0000-0000-0000000d30e4'), 1::bigint, 'músico Pro lê o evento em acesso antecipado');
select is((select count(*) from public.events where id = '00000000-0000-0000-0000-0000000d30e2'), 0::bigint, 'músico Pro não lê evento além de 400 km');

set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000d30a3","role":"authenticated"}';
select is((select count(*) from public.events where id::text like '00000000-0000-0000-0000-0000000d30e%'), 0::bigint, 'músico com visibilidade reduzida não lê eventos abertos de que não participa');

set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000d30c2","role":"authenticated"}';
select is((select count(*) from public.events where id::text like '00000000-0000-0000-0000-0000000d30e%'), 0::bigint, 'outro contratante não lê os eventos abertos do concorrente');

set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000d30c1","role":"authenticated"}';
select is((select count(*) from public.events where id::text like '00000000-0000-0000-0000-0000000d30e%'), 7::bigint, 'o dono continua lendo todos os próprios eventos');

reset role;
select is(has_function_privilege('anon', 'private.evento_aberto_visivel(uuid)', 'execute'), false, 'anon não executa o auxiliar da policy');

select * from finish();
rollback;
