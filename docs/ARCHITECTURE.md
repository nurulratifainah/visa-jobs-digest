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
                     browser ◀─▶ │  • /api/search  (BM25 | KNN | RRF) │
                                 │  • /api/compare (side by side)    │
                                 │  • /api/stats                     │
                                 │  • serves React UI                │
                                 └───────────────────────────────────┘
```

## Event flow

1. **Ingest** — every 15 minutes the ingester pages through the arbeitnow job API, strips HTML, detects explicit visa/relocation mentions with a regex, classifies seniority from the title, lower-cases tags, and inserts rows with `ON CONFLICT (external_id) DO NOTHING`. Only rows that were *actually inserted* produce a `job.created` message — re-scans of the same jobs are free. A database trigger maintains the BM25 inverted index (`job_terms`) in the same transaction as the insert. On startup the ingester also backfills derived fields (seniority) for rows that predate them, so schema evolution never needs a re-ingest.
2. **Queue** — messages go to an SQS-compatible queue. Locally that's ElasticMQ; the services use the real `@aws-sdk/client-sqs`, so production is a one-env-var change (`SQS_ENDPOINT`).
3. **Index** — the indexer long-polls (20s waits, batches of 10), loads the job row, embeds `title. company. location. tags. description[:1500]` with `all-MiniLM-L6-v2` (384-dim, normalized), and writes the vector back. The `UPDATE ... SET embedding` is idempotent — processing a message twice is harmless.
4. **Search** — the API embeds the query with the same model, then runs one SQL statement that does both retrievals and fuses them (see below).

## Search

`services/api/src/search.ts` builds one SQL statement per request from three optional pieces:

- **Keyword candidates** — the query is run through the same `english` text-search configuration as the documents (stemming + stop words), producing lexemes. Two rankers over the *same* lexemes, OR semantics:
  - `bm25` (default): the textbook formula over the `job_terms` inverted index (`tf` field-weighted: title ×5, company ×2, description ×1), with corpus statistics `N` and `avgdl` computed in a CTE.
  - `ts_rank`: Postgres' built-in ranker, for comparison.
- **Semantic candidates** — pgvector cosine KNN over the HNSW index.
- **Fusion** — Reciprocal Rank Fusion, `score = Σ 1/(60 + rank)`, over the top 60 from each retriever. RRF works on ranks, not scores, so BM25 points and cosine similarities never need normalising against each other.

`mode=keyword|semantic|hybrid` selects which pieces are included; in single-retriever modes the returned `score` is that retriever's own score so it stays interpretable. Every row also carries `keyword_rank`, `keyword_score`, `semantic_rank`, `cosine_similarity` — the UI renders these as a one-line "why it ranked" and the compare view puts the three lists side by side.

The maths, the design of the inverted index, and the eval results are in [SEARCH-NOTES.md](SEARCH-NOTES.md).

### Filters are pushed into the retrievers

`remote`, `visa`, `location`, `skills`, `seniority` are rendered into **each** candidate CTE (`filterClause()`), not applied after fusion. The alternative — fuse first, filter after — silently under-fills results: `visa=true` matches ~4% of jobs, so a post-filtered top-60 returns two or three rows. Pre-filtering means both retrievers return 60 candidates that already satisfy the filters. pgvector supports filtered HNSW scans; `skills` uses the GIN index on `tags` (`tags @> ARRAY['python']`) with a text-search fallback so "python" also matches a job that mentions it only in the description.

Parameters are collected by a tiny `Params` helper so SQL fragments compose without positional-placeholder bookkeeping — and, importantly, without ever interpolating user input into SQL.

### Evaluation

`npm run eval` (`src/eval.ts`) runs `eval/queries.json` through five configurations against the live API and reports P@K, R@K, MRR, nDCG@K and latency percentiles. Relevance judgments are heuristic (title regex or tag membership, computed in SQL against the current corpus). They are a regression check for ranking changes, not ground truth; the production equivalent is interaction-based judgments feeding a learning-to-rank model.

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
| BM25 in SQL, not `ts_rank` alone | `ts_rank` has no IDF and no length normalisation. Building BM25 over the same lexemes lets the two be compared fairly and makes every term in the formula visible. |
| Field-weighted `tf` (BM25F-style) | The first eval run showed a flat-field BM25 losing to `ts_rank` because title hits matter far more than description hits for job search. Weighting `tf` at index time fixed it without changing the query. |
| Filters inside each retriever | Post-fusion filtering under-fills results as soon as a filter is selective. See "Filters are pushed into the retrievers". |
| Seniority derived at ingest | The source has no seniority field. A title regex at write time gives an indexed column; a regex at query time gives nothing to index. Backfilled on startup so old rows catch up. |

## Scaling notes (what changes at 100× volume)

- **Indexer** is stateless — run N replicas; SQS visibility timeout already makes that safe.
- **Postgres FTS** → dedicated search engine (Elasticsearch), keeping pgvector or moving to its dense-vector fields; the ingester/queue contract doesn't change.
- **Reconciler** uses a partial index on `(created_at) WHERE embedding IS NULL`, so it stays cheap regardless of table size.
- **BM25 corpus statistics** (`N`, `avgdl`) are aggregated per query; cache them in a one-row table refreshed by the ingester once the table is large.
- **Query embedding** (~130 ms) dominates search latency — cache embeddings of frequent queries.
- **Fan-out**: multiple sources (more boards, the digest agent's findings) all publish the same `job.created` event — the pipeline doesn't care where jobs come from.
