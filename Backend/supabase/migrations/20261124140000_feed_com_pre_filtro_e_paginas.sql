-- Feed do músico: pré-filtro geográfico por caixa de latitude/longitude antes do
-- haversine, e uma variante paginada com ordenação estável.
--
-- musician_feed(p_raio_km) mantém o mesmo contrato (event_id, distancia_km) e as
-- mesmas regras: cidade/raio, estilos, acesso antecipado do Pro (24 horas para
-- eventos com 7 dias ou mais), inscrições encerradas e visibilidade reduzida.
-- A distância que decide continua sendo private.distance_km; a caixa só evita
-- calcular a fórmula para eventos claramente fora do raio.
--
-- musician_feed_pagina é nova e ainda não é usada pelo app: o cliente passa a
-- usá-la só depois desta migration estar aplicada no banco em uso.
--
-- Esta migration não foi aplicada em nenhum banco.

create or replace function private.caixa_de_raio(p_lat double precision, p_lng double precision, p_raio_km integer)
returns table (lat_min double precision, lat_max double precision, lng_min double precision, lng_max double precision, lng_valida boolean)
language sql
immutable
set search_path = ''
as $$
  with graus as (
    select p_raio_km / 111.32 as dlat,
           case when cos(radians(p_lat)) < 0.01 then null else p_raio_km / (111.32 * cos(radians(p_lat))) end as dlng
  )
  select greatest(p_lat - dlat, -90), least(p_lat + dlat, 90),
         p_lng - dlng, p_lng + dlng,
         dlng is not null and p_lng - dlng >= -180 and p_lng + dlng <= 180
  from graus;
$$;

revoke execute on function private.caixa_de_raio(double precision, double precision, integer) from public;
grant execute on function private.caixa_de_raio(double precision, double precision, integer) to authenticated;

create or replace function public.musician_feed(p_raio_km integer default 0)
returns table (event_id uuid, distancia_km numeric)
language sql
stable
security invoker
set search_path = ''
as $$
  with musician as (
    select m.uf, m.cidade, m.estilos_musicais, c.latitude, c.longitude, private.is_pro(m.user_id) as pro,
           least(p_raio_km, case when private.is_pro(m.user_id) then 400 else 200 end) as raio_efetivo
    from public.musician_profiles m
    left join lateral private.municipio_coords(m.uf, m.cidade) c on true
    where m.user_id = (select auth.uid())
      and m.uf is not null and m.cidade is not null and m.estilos_musicais is not null
      and not private.visibility_reduced(m.user_id)
  ),
  caixa as (
    select cx.* from musician mu left join lateral private.caixa_de_raio(mu.latitude, mu.longitude, mu.raio_efetivo) cx on true
  )
  select e.id,
         case
           when e.uf = mu.uf and extensions.unaccent(lower(e.cidade)) = extensions.unaccent(lower(mu.cidade)) then 0
           else private.distance_km(mu.latitude, mu.longitude, c.latitude, c.longitude)
         end as distancia_km
  from public.events e
  cross join musician mu
  cross join caixa cx
  left join lateral private.municipio_coords(e.uf, e.cidade) c on true
  where e.status = 'ABERTO'
    and not e.inscricoes_encerradas
    and e.inicio > now()
    and (
      mu.pro
      or e.created_at <= now() - interval '24 hours'
      or e.inicio - now() < interval '7 days'
    )
    and (e.estilos_musicais && mu.estilos_musicais or 'Qualquer estilo' = any (e.estilos_musicais))
    and (
      (e.uf = mu.uf and extensions.unaccent(lower(e.cidade)) = extensions.unaccent(lower(mu.cidade)))
      or (
        p_raio_km > 0
        and mu.latitude is not null
        and c.latitude between cx.lat_min and cx.lat_max
        and (not cx.lng_valida or c.longitude between cx.lng_min and cx.lng_max)
        and private.distance_km(mu.latitude, mu.longitude, c.latitude, c.longitude) <= least(p_raio_km, case when mu.pro then 400 else 200 end)
      )
    )
  order by distancia_km, e.inicio, e.id;
$$;

-- Página do feed: mesma seleção, ordenada por (distancia_km, inicio, id), com
-- cursor composto pelos três campos da ordenação para não repetir nem pular
-- eventos entre páginas. p_limite máximo de 50.
create or replace function public.musician_feed_pagina(
  p_raio_km integer default 0,
  p_limite integer default 20,
  p_cursor_distancia numeric default null,
  p_cursor_inicio timestamptz default null,
  p_cursor_id uuid default null
)
returns table (event_id uuid, distancia_km numeric, inicio timestamptz)
language sql
stable
security invoker
set search_path = ''
as $$
  select f.event_id, f.distancia_km, e.inicio
  from public.musician_feed(p_raio_km) f
  join public.events e on e.id = f.event_id
  where p_cursor_id is null
     or (f.distancia_km, e.inicio, f.event_id) > (p_cursor_distancia, p_cursor_inicio, p_cursor_id)
  order by f.distancia_km, e.inicio, f.event_id
  limit least(greatest(coalesce(p_limite, 20), 1), 50);
$$;

revoke execute on function public.musician_feed_pagina(integer, integer, numeric, timestamptz, uuid) from public, anon;
grant execute on function public.musician_feed_pagina(integer, integer, numeric, timestamptz, uuid) to authenticated;
