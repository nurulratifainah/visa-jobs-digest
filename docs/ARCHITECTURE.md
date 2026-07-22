# Architecture

## Overview

The system is four services plus two datastores, all wired together by `docker-compose.yml`:

```
┌────────────┐   HTTP (poll)    ┌──────────────────────────────┐
│ arbeitnow  │ ◀──────────────  │ ingester                     │
│ job API    │                  │  • dedupe into Postgres      │
└────────────┘                  │  • publish job.created       │
                                │  • reconcile missed events   │
                                └──────┬───────────────────────┘
                                       │ SendMessage
                                       ▼
                          ┌────────────────────────┐
                          │ SQS queue (ElasticMQ)  │
                          └──────┬─────────────────┘
                                 │ ReceiveMessage (long poll)
                                 ▼
                     ┌───────────────────────────┐      ┌─────────────────────┐
                     │ indexer                   │ ───▶ │ Postgres + pgvector │
                     │  • embed w/ MiniLM (CPU)  │      │  jobs table:        │
                     │  • idempotent UPDATE      │      │  raw + fts + vector │
                     └───────────────────────────┘      └─────────┬───────────┘
                                                                  │ hybrid SQL
                                 ┌────────────────────────────────┴──┐
                                 │ api                               │
                     browser ◀─▶ │  • /api/search  (BM25+KNN+RRF)    │
                                 │  • /api/stats                     │
                                 │  • serves React UI                │
                                 └───────────────────────────────────┘
```

## Event flow

1. **Ingest** — every 15 minutes the ingester pages through the arbeitnow job API, strips HTML, detects explicit visa/relocation mentions with a regex, and inserts rows with `ON CONFLICT (external_id) DO NOTHING`. Only rows that were *actually inserted* produce a `job.created` message — re-scans of the same jobs are free.
2. **Queue** — messages go to an SQS-compatible queue. Locally that's ElasticMQ; the services use the real `@aws-sdk/client-sqs`, so production is a one-env-var change (`SQS_ENDPOINT`).
3. **Index** — the indexer long-polls (20s waits, batches of 10), loads the job row, embeds `title. company. location. tags. description[:1500]` with `all-MiniLM-L6-v2` (384-dim, normalized), and writes the vector back. The `UPDATE ... SET embedding` is idempotent — processing a message twice is harmless.
4. **Search** — the API embeds the query with the same model, then runs one SQL statement that does both retrievals and fuses them (see below).

## Hybrid search

Two candidate lists are produced independently:

- **Keyword**: Postgres full-text search over a stored, weighted `tsvector` (`title` weight A, `company` B, `description` C) using `websearch_to_tsquery`, ranked by `ts_rank`.
- **Semantic**: pgvector cosine KNN over the HNSW index, ranked by distance.

They're merged with **Reciprocal Rank Fusion**: `score = Σ 1/(60 + rank)`. RRF works on ranks, not scores, so there's no need to normalize `ts_rank` values against cosine distances — the two retrievers don't need to agree on what a "good score" is. Each result reports `semantic_hit` / `keyword_hit` so the UI (and you) can see why it ranked.

Filters (`remote`, `visa`) are applied after fusion. At this corpus size that's fine; at scale you'd push filters into both candidate queries (pgvector supports filtered HNSW scans).

## Failure handling: the reconciler

Queue-based pipelines fail in unglamorous ways: consumers crash mid-batch, in-memory queues restart, messages get dropped by bugs. Rather than assuming delivery, the ingester runs a **reconciliation pass** each cycle:

```sql
SELECT id FROM jobs
WHERE embedding IS NULL AND created_at < now() - interval '5 minutes'
```

Anything unindexed after the grace period is re-queued. Because indexing is idempotent, duplicate delivery costs one redundant embedding, not correctness. The database is the source of truth; the queue is just transport.

This wasn't theoretical — it caught a real bug during development (see below).

## War story: the silently vanishing messages 🐛

During the first end-to-end run, all 400 `job.created` messages disappeared: queue empty, zero jobs indexed, no errors anywhere.

The cause: `node-postgres` returns `BIGSERIAL` columns as **strings** (int8 can exceed JS's safe integer range, so the driver refuses to guess). The ingester happily published `{"jobId": "123"}`, and the indexer's guard — `typeof event.jobId === "number"` — rejected every message and deleted it as unrecognized. Two correct-looking services, one silent type mismatch at the serialization boundary.

Three fixes, in order of importance:

1. **Log discards.** The indexer originally deleted non-matching messages silently. Unrecognized input should always leave a trace — one `console.warn` turned an invisible bug into a one-line diagnosis.
2. **Reconcile.** The reconciler re-queued everything once the bug was fixed; no manual backfill needed.
3. **Coerce at the boundary.** Ids are now explicitly `Number()`-ed on both sides. Types inside a service are the compiler's job; types *between* services are yours.

## Design decisions

| Decision | Why |
|---|---|
| One Postgres for rows + FTS + vectors | Transactional consistency, one container, and hybrid search without a search cluster. The queue pattern is unchanged if you later split to Elasticsearch/OpenSearch. |
| ElasticMQ over LocalStack | Single-purpose, tiny, starts in ~1s. Still exercises the real AWS SDK code path. |
| Transformers.js over an embedding API | Zero keys, zero cost, offline, and 384-dim MiniLM is plenty for job-post semantics. The model caches in a shared volume so indexer and api download it once. |
| Embedding in the indexer *and* the api | The query must be embedded in the same vector space as documents. Both load the same model from the shared cache. |
| `websearch_to_tsquery` | Accepts human input safely (quotes, `-exclusions`) without hand-parsing. |

## Scaling notes (what changes at 100× volume)

- **Indexer** is stateless — run N replicas; SQS visibility timeout already makes that safe.
- **Postgres FTS** → dedicated search engine (Elasticsearch), keeping pgvector or moving to its dense-vector fields; the ingester/queue contract doesn't change.
- **Reconciler** query needs an index on `(created_at) WHERE embedding IS NULL` (partial index) to stay cheap.
- **Fan-out**: multiple sources (more boards, the digest agent's findings) all publish the same `job.created` event — the pipeline doesn't care where jobs come from.
