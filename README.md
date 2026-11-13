# Distributed Wagering Processor

Serviço financeiro que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`,
`ROLLBACK`) vindas de vários provedores, com entrega **at-least-once**: mensagens duplicadas,
fora de ordem e concorrentes, em **múltiplas instâncias**, sem duplicar débito ou crédito, sem
saldo negativo e sem perder eventos.

- Enunciado do desafio: [CHALLENGE.md](CHALLENGE.md)
- Decisões, trade-offs e limitações: **[ARCHITECTURE.md](ARCHITECTURE.md)**
- Teste de carga (metodologia e resultados): [load-test/README.md](load-test/README.md)

**Stack:** Bun 1.4 · TypeScript (strict) · NestJS 12 · PostgreSQL 17 · MikroORM 7 · AWS SQS via
LocalStack 4.4 · Docker Compose · Zod · pino · prom-client · OpenTelemetry.

---

## Requisitos

- [Bun](https://bun.sh) 1.4+
- Docker com Docker Compose v2+ (no Windows: Docker Desktop com WSL2)

> O PostgreSQL do Compose é exposto na porta **5433** do host (e não 5432), para não conflitar
> com uma instalação local do PostgreSQL.

## Subindo

```bash
bun install
cp .env.example .env                 # aponta para localhost:5433 e localhost:4566

# Infraestrutura: PostgreSQL (bancos wagering e wagering_test) + LocalStack com as filas
docker compose up -d --wait

# Opção A: aplicação local (um processo com todos os papéis)
bun run migration:up
bun run dev                          # http://localhost:3000

# Opção B: stack completo como em produção: migrations + 3 réplicas atrás do nginx
docker compose --profile app up -d --build --wait     # http://localhost:3000

# Opcional: tracing com Jaeger (UI em http://localhost:16686)
OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4318 \
  docker compose --profile app --profile observability up -d --build --wait
```

As filas são criadas pelo LocalStack na inicialização
([infra/localstack/init](infra/localstack/init/ready.d/01-create-queues.sh)):
`wager-transactions.fifo`, a DLQ `wager-transactions-dlq.fifo` (redrive após 5 recebimentos) e
`wagering-events.fifo` (destino dos eventos de integração).

## Comandos

| Comando                                                        | O que faz                                                                                 |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `bun run dev`                                                  | Aplicação com hot reload (lê `.env`)                                                      |
| `bun run start`                                                | Aplicação sem watch                                                                       |
| `bun run migration:up` / `migration:down` / `migration:status` | Migrations (reversíveis)                                                                  |
| `bun run typecheck` · `bun run lint` · `bun run format`        | Qualidade                                                                                 |
| `bun run test`                                                 | Testes unitários (domínio, sem I/O) — 160 testes                                          |
| `bun run test:integration`                                     | Integração contra PostgreSQL e LocalStack **reais** — 104 testes                          |
| `bun run test:concurrency`                                     | 8 cenários de concorrência com **processos reais** (`bun src/main.ts` × 3)                |
| `bun run test:load`                                            | Teste de carga contra o stack do Compose (ver [load-test/README.md](load-test/README.md)) |

Os testes de integração e de concorrência precisam de `docker compose up -d` (usam o banco
`wagering_test`, recriado pelas próprias migrations, e filas SQS exclusivas por arquivo de teste).

## Papéis da aplicação

Uma única imagem; o que cada processo faz é definido por `APP_ROLES` (padrão: todos):

| Papel      | Responsabilidade                                           |
| ---------- | ---------------------------------------------------------- |
| `api`      | HTTP                                                       |
| `consumer` | Consome `wager-transactions.fifo` (inbox persistente, DLQ) |
| `outbox`   | Publica os eventos da outbox em `wagering-events.fifo`     |
| `pending`  | Reprocessa transações `PENDING_REFERENCE`                  |

Qualquer papel pode rodar em qualquer número de instâncias ao mesmo tempo.

## API

| Método | Rota                                                                  | Descrição                                                                        |
| ------ | --------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `POST` | `/wallets`                                                            | Cria uma wallet (saldo inicial gera uma transação `OPENING` + crédito no ledger) |
| `GET`  | `/wallets/:walletId`                                                  | Saldo e versão                                                                   |
| `GET`  | `/wallets/:walletId/ledger?cursor=&limit=`                            | Ledger paginado (cursor opaco e estável, `limit` 1–200)                          |
| `POST` | `/wallets/:walletId/reconciliation`                                   | Saldo materializado × saldo reconstruído pelo ledger                             |
| `POST` | `/wagering/transactions`                                              | Submete uma transação (header `Idempotency-Key` obrigatório)                     |
| `GET`  | `/wagering/transactions/:transactionId`                               | Consulta por id interno                                                          |
| `GET`  | `/providers/:providerId/wagering/transactions/:externalTransactionId` | Consulta por id do provedor                                                      |
| `GET`  | `/health/live` · `/health/ready`                                      | Liveness · readiness (PostgreSQL + SQS)                                          |
| `GET`  | `/metrics`                                                            | Métricas Prometheus                                                              |

Exemplo:

```bash
curl -s -X POST localhost:3000/wallets -H 'content-type: application/json' -d '{
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "initialBalance": { "amount": "1000.00", "currency": "BRL" }
}'
# {"id":"<walletId>","playerId":"0192f28f-...","balance":{"amount":"1000.00","currency":"BRL"},"version":1}

curl -s -X POST localhost:3000/wagering/transactions \
  -H 'content-type: application/json' -H 'Idempotency-Key: provider-a:transaction-123' -d '{
  "providerId": "provider-a", "externalTransactionId": "transaction-123",
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1", "walletId": "<walletId>",
  "roundId": "round-987", "gameId": "fortune-chimp",
  "kind": "BET", "money": { "amount": "25.00", "currency": "BRL" }
}'
# 201 {"transactionId":"...","status":"PROCESSED","balance":{"amount":"975.00","currency":"BRL"},"idempotentReplay":false}
# Reenviar a mesma requisição: 200 com o MESMO corpo e "idempotentReplay": true
```

**Status HTTP** (iguais em todos os endpoints; todo erro informa `retryable`):

| Status | Significado                                                                           | O provedor pode reenviar?            |
| ------ | ------------------------------------------------------------------------------------- | ------------------------------------ |
| `201`  | Processada agora                                                                      | —                                    |
| `200`  | Replay idempotente de uma transação já processada (resposta original)                 | —                                    |
| `202`  | Aceita, aguardando a transação referenciada (`PENDING_REFERENCE`)                     | Sim, para consultar o resultado      |
| `400`  | Payload inválido (`INVALID_PAYLOAD`, `INVALID_AMOUNT`, `INTERNAL_KIND_NOT_ALLOWED`)   | Não, corrigir o payload              |
| `404`  | Wallet ou transação inexistente                                                       | Não                                  |
| `409`  | Conflito de idempotência (mesma key, payload diferente) ou wallet duplicada           | Não                                  |
| `422`  | Rejeição de regra de negócio, com `failureCode` (replay de uma rejeição também é 422) | Não                                  |
| `503`  | Falha transitória (lock timeout, banco/rede indisponível), com `Retry-After`          | **Sim**, com a mesma Idempotency-Key |

Formato de erro: `{ "error": { "code": "...", "message": "...", "retryable": false, "details": [...] } }`.

Mensagens da fila seguem o envelope da seção 10 do enunciado (`WagerTransactionRequested`, com
`idempotencyKey` dentro de `data`).

## Configuração

Todas as variáveis são validadas na inicialização (Zod); configuração inválida derruba o
processo com uma mensagem clara. Valores padrão em [src/config/env.ts](src/config/env.ts);
exemplo em [.env.example](.env.example). As principais:

| Variável                                                  | Padrão                        | Uso                                                    |
| --------------------------------------------------------- | ----------------------------- | ------------------------------------------------------ |
| `DATABASE_URL`                                            | —                             | PostgreSQL                                             |
| `APP_ROLES`                                               | `api,consumer,outbox,pending` | Papéis deste processo                                  |
| `DB_LOCK_TIMEOUT_MS`                                      | `5000`                        | Espera máxima pelo lock de uma wallet (depois: 503)    |
| `PENDING_REFERENCE_MAX_ATTEMPTS` / `_BASE_MS` / `_MAX_MS` | `8` / `1000` / `128000`       | Tentativas e backoff de `PENDING_REFERENCE`            |
| `SQS_MAX_RECEIVE_COUNT`                                   | `5`                           | Igual ao `maxReceiveCount` do redrive da fila          |
| `SHUTDOWN_GRACE_MS`                                       | `25000`                       | Tempo para concluir o trabalho em andamento no SIGTERM |
| `OTEL_EXPORTER_OTLP_ENDPOINT`                             | (vazio = desligado)           | Tracing OTLP/HTTP                                      |
| `LOG_LEVEL`                                               | `info`                        | Logs JSON                                              |

## Estrutura

```
src/
  shared/domain         Money, erros, FailureCode, backoff, IntegrationEvent
  shared/application    portas: UnitOfWork, Clock, IdGenerator, AppMetrics
  modules/wallet        Wallet, ledger, criação, consultas, reconciliação
  modules/wagering      WagerTransaction, regras de negócio, use cases, HTTP, consumidor SQS, worker de pendentes
  modules/messaging     Inbox, Outbox, publisher da outbox, adapter SQS
  modules/auth          ponto de extensão de autenticação (no-op)
  infrastructure        MikroORM, migrations, unit of work, laço dos workers
  observability         logs (pino + contexto), métricas, tracing
  health                liveness e readiness
test/
  unit · integration · concurrency · support
load-test/              teste de carga e relatório
infra/                  init do LocalStack e do PostgreSQL, nginx
```
