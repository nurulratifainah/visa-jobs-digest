# Search notes: BM25, embeddings, cosine, RRF — and where each lives in this repo

Working notes from building the retrieval layer. Each section is: the idea, the
formula, what it looks like here, and what surprised me.

## 1. Lexical retrieval and BM25

**Idea.** Score a document by how many query terms it contains, but (a) rare
terms count more than common ones, (b) the 10th occurrence of a term is worth
much less than the 1st, and (c) long documents shouldn't win just by containing
more words.

**Formula.**

```
score(D, Q) = Σ_{t ∈ Q}  IDF(t) · tf(t,D) · (k1 + 1)
                          ─────────────────────────────────────
                          tf(t,D) + k1 · (1 − b + b · |D| / avgdl)

IDF(t) = ln( 1 + (N − df(t) + 0.5) / (df(t) + 0.5) )
```

| Symbol | Meaning | Where it comes from here |
|---|---|---|
| `tf(t,D)` | occurrences of term *t* in doc *D* | `job_terms.tf`, from `array_length(positions)` of `unnest(fts)` |
| `df(t)` | docs containing *t* | `count(*) FROM job_terms GROUP BY lexeme` |
| `N` | corpus size | `count(*) FROM jobs` |
| `\|D\|`, `avgdl` | doc length, average doc length | `jobs.doc_len`, `avg(doc_len)` |
| `k1 = 1.2` | tf saturation: higher → tf keeps mattering longer | constant in `search.ts` |
| `b = 0.75` | length normalisation: 0 = ignore length, 1 = fully normalise | constant in `search.ts` |

The whole thing is one SQL statement in `bm25Cte()` (`services/api/src/search.ts`).
The inverted index (`job_terms`) is maintained by a trigger in `db/init.sql`,
so it is always consistent with the `fts` column and uses the exact same
stemming/stop-word pipeline. That matters: BM25 and `ts_rank` here score
*identical tokens*, so the comparison isolates the scoring function.

**`ts_rank` is not BM25.** Postgres' `ts_rank` sums weighted term hits with no
IDF term, and its length normalisation is off by default. In the eval it shows
up as `ts_rank` over-rewarding long job ads that repeat generic words
("engineer", "team", "experience").

**Matching semantics.** Both lexical rankers here use OR over query lexemes
(standard BM25). `websearch_to_tsquery` — what most Postgres FTS code uses —
is AND, which is stricter and hurts recall on long natural-language queries.

**What surprised me.**
- Query-time corpus stats (`N`, `avgdl`) are a full-table aggregate. Fine at
  1k–100k rows; at scale they'd be cached and refreshed by the ingester.
- Stemming makes "java" match "javascript"? No — `english` stemmer keeps them
  distinct — but "engineer" and "engineering" collapse to `engin`, which is
  what you want.

## 2. Embeddings and cosine similarity

**Idea.** A model maps text to a vector such that texts with similar *meaning*
land near each other, regardless of shared words. "backend engineer who works
on search infrastructure" is close to "Software Engineer (Java) — Elasticsearch
platform team" even with zero title overlap.

**Model.** `all-MiniLM-L6-v2`: 6-layer transformer, 384-dim output, mean
pooling over token embeddings, L2-normalised. Runs on CPU in ~100 ms per job
via Transformers.js. Documents and queries **must** go through the same model,
pooling and normalisation — the indexer and API share that code path.

**Cosine similarity.**

```
cos(a, b) = (a · b) / (‖a‖ ‖b‖)      ∈ [−1, 1]
```

Because vectors are normalised, `‖a‖ = ‖b‖ = 1` and cosine is just the dot
product. pgvector's `<=>` operator returns cosine *distance* `1 − cos`, so the
API reports `1 − (embedding <=> query)` as `cosine_similarity`.

**Index.** HNSW (`vector_cosine_ops`) — an approximate nearest-neighbour
graph. Recall is high but not 100%; the trade-off is sub-millisecond KNN
instead of a scan over every vector.

**What surprised me.**
- Absolute cosine values are low (top hits ≈ 0.45–0.55). That is normal for
  MiniLM on short, formulaic text; only the *ranking* matters, never the raw
  value. Do not put a fixed cosine threshold in production.
- The corpus skews German; MiniLM is English-trained, so German ads embed
  poorly and semantic-only results can look random. A multilingual model
  (e.g. `paraphrase-multilingual-MiniLM-L12-v2`) is the first thing to try.
- Embedding the query is the slow part of a search (≈130 ms) — more than both
  SQL queries combined. In production you cache query embeddings.

## 3. Hybrid retrieval and Reciprocal Rank Fusion

**Why hybrid.** Lexical is precise (exact skills, product names, "Kubernetes")
but brittle to vocabulary mismatch. Semantic handles paraphrase but misses
exact tokens and hallucinates similarity on out-of-domain text. Their failures
are uncorrelated, so combining them beats either.

**Why RRF, not score blending.** BM25 scores are unbounded (~0–15 here);
cosine is in [−1, 1]. Any `α·bm25 + β·cos` needs per-query normalisation and
tuning. RRF only uses *ranks*:

```
RRF(d) = Σ_{retrievers r}  1 / (k + rank_r(d))        k = 60
```

A document ranked #1 by one retriever and absent from the other scores
`1/61 ≈ 0.0164`. A document ranked #7 and #3 scores `1/67 + 1/63 ≈ 0.0308` —
almost double. **Agreement beats a single strong signal**, which is exactly
what you can see in the compare view: hybrid's top results are the ones
*both* retrievers liked, even when neither ranked them first.

`k = 60` is the value from the original paper (Cormack et al., 2009) and works
well without tuning; larger `k` flattens the curve so lower ranks matter more.

**Candidates.** Each retriever contributes its top 60. Fusion over 60 + 60
candidates is what makes results in the 10–20 range reasonable; fusing only
top-10 lists would leave most of the tail unscored.

## 4. Filters: push them into the retrievers

Filters (`remote`, `visa`, `location`, `skills`, `seniority`) are rendered
into **every** candidate CTE, not applied after fusion. Post-filtering a top-60
list breaks as soon as a filter is selective: `visa=true` keeps ~4% of jobs, so
a post-filtered top 60 returns two or three results. Pre-filtering means the
KNN and BM25 each return 60 *matching* candidates. pgvector handles the
filtered HNSW scan; the tag GIN index serves `tags @> ARRAY['python']`.

`seniority` is derived at ingest from the title (`detectSeniority` in the
ingester) because the source has no such field — a derived, indexed column
beats a regex at query time.

## 5. Measuring it: `npm run eval`

Ranking changes are invisible without numbers. `services/api/src/eval.ts` runs
16 queries through five configurations and reports:

- **P@10** — fraction of the top 10 that are relevant
- **R@10** — fraction of relevant docs (capped at 10) that made the top 10
- **MRR** — 1 / rank of the first relevant hit
- **nDCG@10** — rank-discounted gain, normalised by the ideal ordering
- **p50 / p95 latency** per request

Judgments are heuristic (title regex or tag membership against the live
corpus). That biases toward lexical matches — the regexes include synonyms
the query does not contain to soften it — so treat absolute numbers as a
regression check, not a benchmark. The production version of this is the
LTR pipeline: judgments from employer clicks and downloads.

Latest run on this machine (1,136 jobs, all embedded, shipped weights):

<!-- eval-results:start -->
| config | P@10 | R@10 | MRR | nDCG@10 | p50 ms | p95 ms |
|---|---|---|---|---|---|---|
| keyword/ts_rank | 0.794 | 0.810 | 1.000 | 0.854 | 10 | 63 |
| keyword/bm25 | 0.656 | 0.673 | 0.938 | 0.717 | 43 | 65 |
| semantic | 0.550 | 0.567 | 1.000 | 0.645 | 21 | 50 |
| hybrid/ts_rank | 0.656 | 0.673 | 1.000 | 0.756 | 26 | 48 |
| hybrid/bm25 | 0.638 | 0.654 | 0.969 | 0.710 | 52 | 61 |
<!-- eval-results:end -->

### What the numbers taught me

**1. A flat-field BM25 lost badly to `ts_rank` (P@10 0.594 vs 0.794).** My
first BM25 counted every occurrence equally wherever it appeared. `ts_rank`
weights title hits 5× description hits by default. For job search the title
*is* the document; a long ad that says "backend" six times should not beat a
job titled "Backend Engineer". Field-weighting the stored `tf` (title ×5,
company ×2, description ×1 — a BM25F approximation) lifted BM25 to 0.656 at
zero query-time cost. Title ×10 pushes it to 0.694, but at that point I am
tuning to judgments that are themselves title-regex based, so the shipped
value stays at 5. That is the whole point of having the eval: the knob's effect
is visible, and so is the bias of the measurement.

**2. `ts_rank` still wins here, and that is partly the judge's fault.** The
relevant sets are defined mostly by title patterns, which structurally favours
a title-heavy ranker. Real judgments (clicks, applies) would reward matching
the *description* — the skills list, the visa clause — which is where IDF and
length normalisation earn their keep. Lesson: the eval is only as good as its
judgments; build the judgment pipeline before tuning the ranker.

**3. Hybrid did not beat the best single retriever.** RRF weights both lists
equally, so when one retriever is clearly weaker (semantic on a German-heavy
corpus with an English model, scored by title regexes) it drags the fused list
down. Hybrid *does* win on MRR — the first result is almost always right —
because agreement between retrievers is a strong signal at the very top. Fixes
in order of cheapness: weighted RRF (`w_r / (k + rank)`), a multilingual
embedding model, a cross-encoder re-ranker over the fused top 50.

**4. Latency.** BM25 in SQL costs ~40 ms at 1.1k docs / 330k postings, most of
it the per-query `df` and corpus aggregates; `ts_rank` over the GIN index is
~10 ms. Query embedding (~130 ms, not included above because eval hits one
mode at a time) dominates everything. Cache it.

## Reading list

- Robertson & Zaragoza, *The Probabilistic Relevance Framework: BM25 and Beyond* (2009)
- Cormack, Clarke & Buettcher, *Reciprocal Rank Fusion outperforms Condorcet and individual rank learning methods* (SIGIR 2009)
- Reimers & Gurevych, *Sentence-BERT* (2019) — where MiniLM sentence embeddings come from
- Malkov & Yashunin, *HNSW* (2016)
- pgvector README — filtered HNSW scans and `hnsw.ef_search`
