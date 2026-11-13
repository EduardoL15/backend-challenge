# Teste de carga

```bash
docker compose --profile app up -d --build   # 3 réplicas + nginx + Postgres + LocalStack
bun run test:load                            # padrão: 32 VUs, 30 s, 100 wallets, 1000 mensagens SQS
```

Parâmetros (variáveis de ambiente): `LOAD_VUS`, `LOAD_DURATION_S`, `LOAD_WALLETS`, `LOAD_HOT_RATIO`,
`LOAD_REPLAY_RATIO`, `LOAD_SQS_MESSAGES`, `LOAD_BASE_URL`, `LOAD_DATABASE_URL`, `LOAD_SQS_ENDPOINT`.
O resultado bruto de cada execução vai para `load-test/results/<timestamp>.json` (não versionado),
com a série temporal da outbox. O script sai com código 2 se a invariante financeira for violada.

## Metodologia

**Alvo:** o stack real do Compose — 3 réplicas da aplicação (todos os papéis: api, consumer,
outbox, pending) atrás de nginx, PostgreSQL 17 e LocalStack (SQS). Mesma imagem e mesmo código
avaliados nos testes.

**Experimento A — HTTP em malha fechada.** N usuários virtuais (VUs); cada um envia a próxima
requisição só depois de receber a resposta (o throughput medido é o que o sistema sustenta, não
uma taxa imposta). Mistura de requisições:

- 80% BET, 15% WIN, 5% LOSS, valores de 1,00 BRL (saldos altos: nenhuma rejeição por saldo, para
  medir o caminho feliz);
- `LOAD_HOT_RATIO` (padrão 20%) das requisições numa **única wallet "quente"** — mede o custo da
  serialização por wallet (lock de linha);
- `LOAD_REPLAY_RATIO` (padrão 10%) **reenvios idênticos** de requisições anteriores — mede o custo
  do replay idempotente.

**Experimento B — fila.** M mensagens `WagerTransactionRequested` publicadas na
`wager-transactions.fifo` o mais rápido possível (lotes de 10, `MessageGroupId` = wallet).
Mede a vazão de drenagem e a latência **ponta a ponta** (envio → commit da inbox, lido do banco).

**Durante tudo:** a cada 1 s, backlog e lag da outbox (idade do evento não publicado mais antigo),
lidos direto do PostgreSQL.

**Depois:** deltas das métricas do servidor (`/metrics` raspado repetidamente pelo nginx até
cobrir as 3 réplicas; séries somadas pelo label `instance`) e a **verificação de correção sob
carga**: `wallet.balance == soma do ledger` para **todas** as wallets do banco.

**Latências** são percentis por _nearest-rank_ sobre as amostras brutas do cliente (sem
aproximação por histograma). "Erro" = 5xx ou falha de rede; 4xx de negócio não são erro.

## Ambiente

| Item             | Valor                                                                           |
| ---------------- | ------------------------------------------------------------------------------- |
| Host             | AMD Ryzen 5 5600GT (6 núcleos / 12 threads), 7,3 GB RAM, Windows 11             |
| Docker           | Docker Desktop (WSL2), VM limitada a **4 vCPUs / 4 GB** (`.wslconfig`)          |
| Réplicas         | 3 × aplicação, limite de 256 MB cada; nginx 1.27; PostgreSQL 17; LocalStack 4.4 |
| Runtime          | Bun 1.4.4; logs JSON nível `info` (uma linha por requisição e por decisão)      |
| Gerador de carga | Bun, **no mesmo host** (fora da VM do Docker)                                   |

## Resultados

Todas as execuções: **0% de erro (5xx/rede), 0 lock timeouts, 0 deadlocks, 0 mensagens na DLQ,
0 falhas de publicação e 0 wallets inconsistentes.**

### A. HTTP

| Execução          | VUs | Wallet quente | Requisições | Throughput    | p50 / p95 / p99 (ms) — todas | p50 / p95 / p99 (ms) — wallet quente |
| ----------------- | --- | ------------- | ----------- | ------------- | ---------------------------- | ------------------------------------ |
| 1 (linha de base) | 16  | 20%           | 7.016       | **233 req/s** | 29,6 / 289 / 516             | 219 / 530 / 802                      |
| 1 (repetição)     | 16  | 20%           | 8.138       | **271 req/s** | 28,0 / 254 / 401             | 192 / 414 / 555                      |
| 2 (saturação)     | 64  | 20%           | 8.074       | **267 req/s** | 160 / 763 / 1.177            | 562 / 1.209 / 1.549                  |
| 3 (pior caso)     | 32  | **100%**      | 4.154       | **138 req/s** | 247 / 362 / 448              | 252 / 366 / 457                      |

Latência por categoria na linha de base (execução 1): wallets espalhadas **27 / 66 / 109 ms**,
replays **8 / 22 / 84 ms**.

### B. Fila (SQS)

| Execução      | Mensagens | Envio | Drenagem | Vazão     | Ponta a ponta p50 / p95 / p99 (ms) |
| ------------- | --------- | ----- | -------- | --------- | ---------------------------------- |
| 1             | 1.000     | 1,8 s | 6,6 s    | 151 msg/s | 2.049 / 4.590 / 4.903              |
| 1 (repetição) | 1.000     | 1,5 s | 6,8 s    | 147 msg/s | 2.234 / 5.157 / 5.500              |
| 2             | 500       | 1,3 s | 2,8 s    | 180 msg/s | 831 / 1.589 / 1.933                |
| 3             | 500       | 1,1 s | 3,9 s    | 129 msg/s | 1.379 / 2.584 / 2.687              |

### Outbox

| Execução | Backlog máximo | Lag máximo | Drenada após o fim da carga |
| -------- | -------------- | ---------- | --------------------------- |
| 1        | 742 eventos    | 2,34 s     | 0,5 s                       |
| 2        | 364 eventos    | 0,64 s     | 0,5 s                       |
| 3        | 182 eventos    | 0,68 s     | 1,5 s                       |

### Uso de recursos no pico (64 VUs, `docker stats` no meio da execução)

| Container             | CPU                          | Memória                     |
| --------------------- | ---------------------------- | --------------------------- |
| postgres              | 87%                          | 237 MB                      |
| app-1 / app-2 / app-3 | 53% / 67% / 89%              | 164 / 142 / 155 MB (de 256) |
| localstack            | 26%                          | 346 MB                      |
| nginx                 | 9%                           | 8 MB                        |
| **Total**             | **≈ 330% de 400% (4 vCPUs)** |                             |

## Análise

1. **Correção não degrada com carga.** ~27 mil requisições HTTP e 3 mil mensagens, com
   concorrência real entre 3 réplicas, e a invariante saldo == ledger vale para todas as
   wallets em todas as execuções. Replays observados pelo cliente batem exatamente com as
   duplicatas contadas pelo servidor (ex.: 678 = 678), o que também valida a medição.

2. **O teto (~230–270 req/s) é CPU, não a arquitetura.** De 16 para 64 VUs (4× mais
   concorrência) o throughput sobe só ~15% e a p50 cresce ~5×: o excesso de concorrência vira
   fila. No pico a VM está em ~330% de 400% de CPU, com o PostgreSQL perto de um núcleo
   inteiro; memória sobra. Não houve lock timeout nem deadlock — o sistema satura de forma
   "limpa" (mais latência, zero erro). Os números absolutos dizem pouco sobre produção: tudo
   (3 réplicas, banco, LocalStack, nginx **e o gerador**) disputa 4 vCPUs de uma única máquina.

3. **A wallet quente é o limite estrutural escolhido.** O lock pessimista serializa as
   operações de uma wallet: com 100% do tráfego numa só wallet, ela sustenta **~138 tx/s**, ou
   seja, ~7 ms de seção crítica por transação (lookup de idempotência, lock, regras, inserts e
   triggers adiadas de consistência no COMMIT). Com 32 VUs na fila desse lock, a p50 de ~250 ms
   é praticamente 32 × 7–8 ms de espera. É o trade-off documentado: correção e simplicidade por
   wallet em troca de vazão por wallet; wallets diferentes escalam em paralelo (na linha de base,
   wallets espalhadas têm p50 de 27 ms enquanto a quente tem ~200 ms).

4. **Replay idempotente é barato:** p50 de 8 ms, porque a primeira consulta da
   Idempotency-Key acontece **sem lock** e responde antes de tocar a wallet.

5. **A latência ponta a ponta da fila é dominada pelo backlog.** As 1.000 mensagens chegam em
   ~1,7 s mas são drenadas em ~6,7 s (~150 msg/s), então uma mensagem média espera ~2 s na fila.
   A vazão do consumidor é limitada pela mesma CPU e pelo processamento em série dentro de
   cada `MessageGroupId` (wallet), que preserva a ordem por wallet.

6. **A outbox acompanha a carga:** lag máximo de 0,6–2,3 s e drenagem completa em até 1,5 s
   após o fim da carga, sem nenhuma falha de publicação, com 3 publishers concorrentes.

## Limitações e incerteza (leia antes de comparar números)

- **Variação entre execuções:** a mesma configuração (16 VUs) deu 233 e 271 req/s (~16% de
  diferença). Diferenças menores que isso entre execuções não são significativas.
- **Gerador no mesmo host** que o sistema testado: rouba CPU do sistema e infla a latência.
- **Docker Desktop/WSL2 no Windows** e **LocalStack** (não o SQS real): rede e I/O virtualizados.
- Cada execução dura 30 s: não mede efeitos de longo prazo (crescimento de tabelas, vacuum,
  vazamento de memória).
- Logs `info` por requisição têm custo e estão incluídos nos números (como em produção).
- Sem rejeições por saldo no experimento A (saldos altos de propósito): o custo do caminho de
  rejeição não foi isolado.

## Próximos passos se o objetivo fosse escalar

- Rodar o gerador em outra máquina e o banco em hardware dedicado, para medir a aplicação e não
  a disputa de CPU.
- Medir o tempo de espera por lock no PostgreSQL (`pg_stat_activity` / `pg_locks`) para separar
  espera de lock de tempo de CPU na wallet quente.
- Reduzir round-trips dentro da seção crítica (ex.: juntar as consultas de idempotência e de
  `externalTransactionId`), o que aumenta diretamente o teto por wallet.
