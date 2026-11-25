-- Chaves de idempotência para operações de criação da API (POST /events e
-- POST /candidaturas/:id/mensagens), para uma requisição repetida depois de um
-- timeout devolver o resultado original em vez de criar outro registro.
--
-- Esta migration só prepara a estrutura. A API ainda não usa a tabela: o código
-- de runtime depende de ela existir no banco em uso e entra em uma etapa
-- posterior, depois da aplicação desta migration.
create table public.request_idempotency (
  user_id uuid not null references public.profiles (id) on delete cascade,
  escopo text not null check (escopo in ('CRIAR_EVENTO', 'ENVIAR_MENSAGEM')),
  chave text not null check (length(chave) between 8 and 128),
  status text not null default 'EM_ANDAMENTO' check (status in ('EM_ANDAMENTO', 'CONCLUIDA')),
  resposta_status integer check (resposta_status between 200 and 299),
  resposta jsonb,
  created_at timestamptz not null default now(),
  concluida_em timestamptz,
  primary key (user_id, escopo, chave),
  constraint request_idempotency_resposta_completa check ((status = 'CONCLUIDA') = (resposta_status is not null))
);

create index request_idempotency_created_at_idx on public.request_idempotency (created_at);

alter table public.request_idempotency enable row level security;

-- RLS ativo e nenhuma policy: só a service_role (API) lê e grava.
