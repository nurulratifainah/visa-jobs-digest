# Visa Jobs — Semantic Search Engine 🛂🔍

An event-driven **semantic job search engine** for visa-friendly tech jobs, plus an autonomous [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/quickstart) digest agent. One `docker compose up` runs the whole thing.

```
                    ┌─────────────────────────────────────────────────────┐
                    │                   docker compose                     │
                    │                                                      │
 arbeitnow API ───▶ │  ingester ──── new job rows ────▶ Postgres+pgvector  │
                    │      │                                ▲    ▲         │
                    │      │ "job.created" event            │    │         │
                    │      ▼                                │    │         │
                    │  SQS queue (ElasticMQ) ──▶ indexer ───┘    │         │
                    │                     embeds w/ MiniLM       │         │
                    │                                            │         │
 browser ◀────────▶ │  React UI ◀── api (hybrid BM25+KNN, RRF) ──┘         │
                    └─────────────────────────────────────────────────────┘

 (separate) GitHub Actions cron ──▶ digest agent (Claude Agent SDK) ──▶ digests/*.md
```

## What it demonstrates

- **Event-driven architecture** — the ingester publishes a `job.created` message per new job to an SQS queue; the indexer consumes and embeds asynchronously. Uses the real `@aws-sdk/client-sqs` against [ElasticMQ](https://github.com/softwaremill/elasticmq), so pointing `SQS_ENDPOINT` at real AWS SQS is the only change needed for production.
- **Reconciliation over blind trust** — queues are at-least-once and consumers crash; a reconciler re-queues any job still unindexed after 5 minutes. Indexing is idempotent, so duplicates are harmless.
- **Hybrid search relevance** — every query runs both full-text (Postgres `tsvector`, weighted title > company > description) and vector KNN (pgvector HNSW, cosine) retrieval, fused with Reciprocal Rank Fusion. The UI shows which retriever(s) matched each hit.
- **Local embeddings** — `all-MiniLM-L6-v2` (384-dim) via Transformers.js, running on CPU inside the containers. No API keys, no external calls; the model is cached in a shared Docker volume.
- **Agentic automation** — the original digest agent (in `agent/`) still runs twice a week via GitHub Actions, using Claude's `WebSearch`/`WebFetch` to hand-curate visa-sponsored roles into markdown digests.

## Run it

```bash
docker compose up --build
# UI + API on http://localhost:8080  (override with API_PORT=8090 docker compose up)
```

First start downloads the embedding model (~90 MB, cached in a volume). Within a minute or two the ingester pulls ~400 jobs, fans them through the queue, and the indexer embeds them. Watch it happen:

```bash
docker compose logs -f ingester indexer
curl localhost:8080/api/stats
```

Try a semantic query — no keyword overlap required:

```bash
curl "localhost:8080/api/search?q=backend+engineer+search+infrastructure&visa=true"
```

## Services

| Service | Path | Role |
|---|---|---|
| `ingester` | `services/ingester` | Polls the arbeitnow job API, dedupes into Postgres, publishes `job.created` events, reconciles missed indexing |
| `indexer` | `services/indexer` | Long-polls SQS, embeds jobs with MiniLM, writes vectors to pgvector |
| `api` | `services/api` | Hybrid search endpoint (FTS + KNN + RRF), stats, serves the UI |
| `web` | `web` | React + Vite search UI with remote/visa filters |
| `agent` | `agent` | Claude Agent SDK digest agent (scheduled via GitHub Actions) |

## API

| Endpoint | Description |
|---|---|
| `GET /api/search?q=...&remote=true&visa=true&limit=20` | Hybrid search; without `q` returns newest jobs |
| `GET /api/stats` | Corpus counts and last ingest time |

Search response items include `score` (RRF), `semantic_hit`, and `keyword_hit` so you can see *why* something ranked.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — event flow, hybrid search internals, failure handling, the reconciler, and a debugging war story about silently vanishing queue messages.

## Why this stack?

Every choice here optimizes for the same thing: **the smallest system that demonstrates the real production patterns** — event-driven indexing, hybrid retrieval, failure recovery — with zero external accounts and one `docker compose up`.

### Postgres + pgvector, not Elasticsearch

I use Elasticsearch professionally (KNN + BM25 hybrid search over millions of candidate profiles), so this was a deliberate trade, not unfamiliarity:

- **Right-sized.** ES wants ~1 GB of heap before it says hello. For a 400–100k document corpus, `tsvector` (weighted BM25-style ranking) + pgvector's HNSW index cover both retrievers in one ~50 MB container.
- **One source of truth.** Raw rows, full-text index, and vectors live in the same table — the FTS index updates transactionally with the insert, so there's no dual-write/sync problem between a database and a search cluster. In production systems that sync *is* the hard part (it's exactly what the SQS pipeline here handles for the vector side).
- **The architecture doesn't lock you in.** The indexing contract is "consume `job.created`, write to the index." Swapping Postgres for Elasticsearch changes the indexer's write target and the API's query — the ingester, queue, event schema, and reconciler are untouched. That boundary is the point of the design.
- **When I'd switch:** corpus in the millions, heavy faceting/aggregations, per-field relevance tuning (analyzers, synonyms, function scores), or index-time sharding — that's ES territory.

### ElasticMQ, not real SQS / LocalStack / Kafka / Redis

- **Real SQS** needs an AWS account — a hard "no" for a repo strangers should be able to run. ElasticMQ speaks the SQS wire protocol, so the services use the production `@aws-sdk/client-sqs`, and deploying against real SQS is a one-env-var change (`SQS_ENDPOINT`). The code you review is the code that would ship.
- **LocalStack** emulates all of AWS; I only need a queue. ElasticMQ is a single-purpose ~40 MB image that starts in about a second.
- **Kafka** is for streams: replay, ordering, many consumer groups, retention. This is a work queue — each message processed once, then gone. SQS semantics (visibility timeout, at-least-once) match the job, and a queue you drain is simpler to reason about than an offset you rewind.
- **Redis/BullMQ** would work, but demonstrates a Redis-specific API. The AWS SDK integration is the more transferable pattern.

### Local embeddings (Transformers.js + MiniLM), not an embeddings API

- **Zero keys, zero cost, works offline** — anyone can clone and run without signing up for anything. An API-key requirement kills a demo repo.
- `all-MiniLM-L6-v2` is 384-dim, ~90 MB, and embeds a job post in ~100 ms on CPU. For short semi-structured text like job posts, bigger models buy little extra relevance.
- Runs **in-process in Node** — no Python sidecar, no inference server, one less container.
- **Trade-off:** a hosted or larger model wins on multilingual nuance — visible here since arbeitnow skews German. The embedding call is one function; swapping it is a 5-line change.

### A queue at all, not just "embed on insert"

The ingester could call the embedder directly — at 400 jobs that would even be simpler. The queue exists because it's the pattern that survives scale: ingestion and indexing scale independently (embedding is CPU-bound — run N indexers; visibility timeouts already make that safe), a burst of 10k jobs degrades into a backlog instead of an outage, and an indexer crash loses nothing. The reconciler then covers the queue's own failure modes — see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the bug that proved it necessary.

### The boring choices

- **TypeScript everywhere** — one language across three services and the frontend; strict mode catches contract drift between them.
- **Express** — the API is two endpoints; a more opinionated framework would be more to read, not more to learn from.
- **React + Vite** — the UI's job is to make `semantic_hit` vs `keyword_hit` visible, not to be clever.
- **Docker Compose** — the whole pipeline is one command. Reviewers don't read setup docs; Kubernetes here would demonstrate ops, not search.

### Other notes

- **Why RRF for fusion?** Rank-based fusion needs no score normalization between `ts_rank` values and cosine distances — the two retrievers never have to agree on what a "good score" is. `score = Σ 1/(60 + rank_i)`.
- **Why detect visa support by keywords at ingest?** The source API has no visa flag. A regex over title/tags/description marks explicit mentions cheaply at write time; semantic search catches implicit ones at query time.

## Digest agent (the original project)

Lives in `agent/` — an autonomous researcher that scans job boards for visa-sponsored roles matching `agent/jobs.config.json` and writes verified markdown digests. Runs Mon/Thu via `.github/workflows/digest.yml` (needs an `ANTHROPIC_API_KEY` repo secret). Locally: `cd agent && npm run digest`.

## License

MIT
