# Muve

Aplicativo que conecta músicos independentes a contratantes de eventos. O Muve intermedeia contratações e pagamentos por Pix, retendo o valor até a realização do evento. Após a conclusão, o pagamento é repassado ao músico e ambas as partes podem se avaliar.

## Funcionalidades

- **Eventos:** publicação de oportunidades com data, local, estilos musicais e cachê, direcionadas a músicos compatíveis em um raio de até 200 km.
- **Inscrições e negociação:** músicos podem aceitar o cachê ou propor outro valor, com conversa integrada ao aplicativo.
- **Contratação e pagamento:** cobrança por Pix, com validade de 15 minutos. O valor fica retido até a conclusão do evento.
- **Cancelamentos e ausências:** regras de estorno, compensação ao músico e registro de ausência.
- **Conclusão e avaliações:** confirmação do evento, repasse por Pix, avaliações de 1 a 5 e possibilidade de contestação.
- **Planos e notificações:** Muve Pro, Muve Casa e notificações pelo aplicativo, e-mail e push.

## Tecnologias

| Camada | Tecnologias |
|---|---|
| Aplicativo | React Native, Expo SDK 58 |
| API | Node.js 22, Hono, Zod |
| Banco de dados | Supabase, PostgreSQL e RLS |
| Pagamentos | Asaas (Pix) |
| Código compartilhado | TypeScript, pacote `@muve/shared` |
| Testes | Vitest, pgTAP e testes E2E |

## Estrutura

```text
.
├── Backend/    API, scripts e banco de dados
├── Mobile/     Aplicativo Expo
├── shared/     Regras e contratos compartilhados
└── package.json
```

O aplicativo utiliza o banco apenas para leitura. Todas as operações de escrita passam pela API.

## Pré-requisitos

- Node.js 22.18 ou superior.
- pnpm 12.
- npm.
- Expo Go compatível com o SDK 58.
- Docker e CLI do Supabase para testes locais de banco.

## Instalação

Na raiz do projeto:

```bash
pnpm install --frozen-lockfile
```

A instalação utiliza pnpm na raiz e no Backend, e npm no Mobile. Não execute comandos pnpm diretamente dentro de `Mobile/`.

## Configuração

Copie os arquivos de exemplo e configure as variáveis de ambiente:

- `Backend/.env.example` → `Backend/.env`
- `Mobile/.env.example` → `Mobile/.env`

As chaves privadas e credenciais de pagamento devem permanecer exclusivamente no Backend.

## Execução

Abra dois terminais na raiz do projeto.

**API:**

```bash
pnpm dev:api
```

**Aplicativo:**

```bash
pnpm dev:app
```

O aplicativo será disponibilizado pelo Metro Bundler, que exibirá um QR code para abertura no Expo Go.

## Testes e qualidade

Na raiz do projeto:

```bash
pnpm typecheck
pnpm lint
pnpm test
```

O Backend também disponibiliza testes E2E, testes de concorrência e testes de banco com pgTAP.

## Integração contínua

O GitHub Actions executa automaticamente typecheck, lint, testes dos três projetos e geração do bundle Android em pushes para `main` e pull requests.

## Banco de dados

O projeto utiliza Supabase com PostgreSQL, políticas RLS, funções e migrations versionadas.

As migrations não são aplicadas automaticamente. Alterações no banco devem seguir a ordem de implantação definida para cada funcionalidade.

## Notificações

O aplicativo utiliza notificações locais e push remoto.

- **Android:** push remoto não está disponível no Expo Go; requer um development build.
- **iOS:** o suporte a push remoto pelo Expo Go não foi validado neste projeto. Para maior confiabilidade, recomenda-se um development build.