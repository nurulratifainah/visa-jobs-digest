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

## Design notes

- **Why RRF?** Rank-based fusion needs no score normalization between BM25-style `ts_rank` and cosine distance — robust and simple. `score = Σ 1/(60 + rank_i)`.
- **Why one Postgres for both retrievers?** One container, transactional consistency between raw rows and vectors, and `tsvector` + `pgvector` cover hybrid search without an extra search cluster. At larger scale you'd split into a dedicated engine (Elasticsearch/OpenSearch) — the queue-based indexing pattern stays identical.
- **Why detect visa support by keywords at ingest?** The source API has no visa flag. A regex over title/tags/description marks explicit mentions; semantic search catches the rest at query time.

## Digest agent (the original project)

Lives in `agent/` — an autonomous researcher that scans job boards for visa-sponsored roles matching `agent/jobs.config.json` and writes verified markdown digests. Runs Mon/Thu via `.github/workflows/digest.yml` (needs an `ANTHROPIC_API_KEY` repo secret). Locally: `cd agent && npm run digest`.

## License

MIT
