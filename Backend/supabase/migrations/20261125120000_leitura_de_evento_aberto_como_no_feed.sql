-- Leitura direta de evento aberto limitada ao que o feed mostraria.
--
-- Antes, a policy de public.events liberava a qualquer usuário autenticado todo
-- evento com status ABERTO, com todas as colunas. Um select direto na tabela
-- contornava as regras de public.musician_feed: cidade ou raio, estilos, acesso
-- antecipado do Pro, inscrições encerradas, início futuro e visibilidade reduzida.
--
-- Agora o evento aberto é legível por: o contratante dono, o músico contratado,
-- o músico inscrito, o músico convidado, e o músico para quem o feed mostraria o
-- evento no maior raio do seu plano (200 km, ou 400 km para o Pro).
--
-- Esta migration não foi aplicada em nenhum banco.

create function private.evento_aberto_visivel(p_event_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.event_invites i
    where i.event_id = p_event_id and i.musician_id = (select auth.uid())
  ) or exists (
    select 1
    from public.events e
    join public.musician_profiles m on m.user_id = (select auth.uid())
    left join lateral private.municipio_coords(m.uf, m.cidade) mc on true
    left join lateral private.municipio_coords(e.uf, e.cidade) ec on true
    where e.id = p_event_id
      and not e.inscricoes_encerradas
      and e.inicio > now()
      and m.uf is not null and m.cidade is not null and m.estilos_musicais is not null
      and not private.visibility_reduced(m.user_id)
      and (
        private.is_pro(m.user_id)
        or e.created_at <= now() - interval '24 hours'
        or e.inicio - now() < interval '7 days'
      )
      and (e.estilos_musicais && m.estilos_musicais or 'Qualquer estilo' = any (e.estilos_musicais))
      and (
        (e.uf = m.uf and extensions.unaccent(lower(e.cidade)) = extensions.unaccent(lower(m.cidade)))
        or private.distance_km(mc.latitude, mc.longitude, ec.latitude, ec.longitude) <= case when private.is_pro(m.user_id) then 400 else 200 end
      )
  );
$$;

revoke execute on function private.evento_aberto_visivel(uuid) from public;
grant execute on function private.evento_aberto_visivel(uuid) to authenticated;

drop policy "eventos abertos, proprios ou com participacao" on public.events;

create policy "eventos proprios, com participacao ou visiveis no feed" on public.events
for select to authenticated
using (
  contractor_id = (select auth.uid())
  or musico_contratado_id = (select auth.uid())
  or private.is_event_candidate(id)
  or (status = 'ABERTO' and private.evento_aberto_visivel(id))
);
