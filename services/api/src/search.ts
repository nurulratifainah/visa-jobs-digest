/**
 * Search query builder: three retrieval modes, two lexical rankers, structured
 * filters pushed into every candidate query, and RRF fusion — all in one SQL
 * round-trip per search.
 *
 *   mode=keyword   lexical only  (BM25 in SQL, or Postgres ts_rank)
 *   mode=semantic  pgvector cosine KNN only
 *   mode=hybrid    both, fused with Reciprocal Rank Fusion
 *
 * See docs/SEARCH-NOTES.md for the maths and docs/ARCHITECTURE.md for why
 * filters are applied *before* fusion rather than after.
 */

export type Mode = "hybrid" | "keyword" | "semantic";
export type Lexical = "bm25" | "ts_rank";

export interface Filters {
  remote: boolean | null;
  visa: boolean | null;
  /** Case-insensitive substring match on the location column. */
  location: string | null;
  /** Every skill must appear either as a tag or as a term in title/description. */
  skills: string[];
  /** Any of these seniority buckets (see ingester detectSeniority). */
  seniority: string[];
}

export interface SearchOptions {
  mode: Mode;
  lexical: Lexical;
  query: string;
  /** JSON-encoded query embedding; required for semantic/hybrid. */
  queryVector: string | null;
  filters: Filters;
  limit: number;
}

export const RRF_K = 60; // standard reciprocal-rank-fusion constant
export const CANDIDATES = 60; // candidates per retriever before fusion
export const BM25_K1 = 1.2; // term-frequency saturation
export const BM25_B = 0.75; // document-length normalisation (0 = off, 1 = full)

/** Collects positional parameters so SQL fragments can be composed safely. */
class Params {
  readonly values: unknown[] = [];
  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

/**
 * Filters are rendered once per retriever so each candidate list is already
 * filtered when it reaches fusion. Post-filtering a top-60 list would return
 * fewer than `limit` rows as soon as a filter is selective ("visa=true" keeps
 * ~5% of jobs) — the classic filtered-KNN bug.
 */
function filterClause(alias: string, p: Params, f: Filters): string {
  const parts: string[] = [];
  if (f.remote !== null) parts.push(`${alias}.remote = ${p.add(f.remote)}::boolean`);
  if (f.visa !== null) parts.push(`${alias}.visa_sponsorship = ${p.add(f.visa)}::boolean`);
  if (f.location) parts.push(`${alias}.location ILIKE ${p.add(`%${f.location}%`)}`);
  if (f.seniority.length > 0) parts.push(`${alias}.seniority = ANY(${p.add(f.seniority)}::text[])`);
  if (f.skills.length > 0) {
    // "all skills present": no skill may be missing from both tags and text.
    parts.push(
      `NOT EXISTS (
         SELECT 1 FROM unnest(${p.add(f.skills)}::text[]) AS s
         WHERE NOT (${alias}.tags @> ARRAY[s] OR ${alias}.fts @@ plainto_tsquery('english', s))
       )`,
    );
  }
  return parts.length > 0 ? parts.join(" AND ") : "TRUE";
}

const RESULT_COLUMNS = `
  j.id, j.title, j.company, j.location, j.remote, j.visa_sponsorship, j.seniority,
  j.tags, j.url, j.posted_at, left(j.description, 280) AS snippet`;

/**
 * Semantic candidates: cosine KNN over the HNSW index. `<=>` is cosine
 * *distance* (1 - similarity), so similarity is reported as 1 - distance.
 */
function semanticCte(p: Params, vec: string, f: Filters): string {
  const v = p.add(vec);
  return `
semantic AS (
  SELECT j.id,
         1 - (j.embedding <=> ${v}::vector) AS score,
         ROW_NUMBER() OVER (ORDER BY j.embedding <=> ${v}::vector) AS rnk
  FROM jobs j
  WHERE j.embedding IS NOT NULL AND ${filterClause("j", p, f)}
  ORDER BY j.embedding <=> ${v}::vector
  LIMIT ${p.add(CANDIDATES)}
)`;
}

/**
 * Query lexemes: run the query through the same `english` text-search config
 * the documents use, so stemming and stop-word removal match on both sides.
 * Both lexical rankers use OR semantics over these lexemes, so the only thing
 * that differs between them is the scoring function.
 */
function queryTermsCte(p: Params, query: string): string {
  return `
qterms AS (
  SELECT DISTINCT t.lexeme FROM unnest(to_tsvector('english', ${p.add(query)})) AS t
)`;
}

/**
 * BM25, straight from the formula:
 *
 *   score(D, Q) = Σ_{t ∈ Q} IDF(t) · tf(t,D)·(k1 + 1) / (tf(t,D) + k1·(1 − b + b·|D|/avgdl))
 *   IDF(t)      = ln(1 + (N − df(t) + 0.5) / (df(t) + 0.5))
 *
 * Every quantity is a column or an aggregate over `job_terms`, so it is plain
 * SQL. Corpus statistics (N, avgdl) are computed per query, which is fine up
 * to ~100k docs; beyond that, cache them.
 */
function bm25Cte(p: Params, f: Filters): string {
  const k1 = p.add(BM25_K1);
  const b = p.add(BM25_B);
  return `
corpus AS (
  SELECT count(*)::float8 AS n, avg(doc_len)::float8 AS avgdl FROM jobs WHERE doc_len IS NOT NULL
),
df AS (
  SELECT lexeme, count(*)::float8 AS df
  FROM job_terms WHERE lexeme IN (SELECT lexeme FROM qterms)
  GROUP BY lexeme
),
bm25 AS (
  SELECT t.job_id AS id,
         sum(
           ln(1 + (c.n - d.df + 0.5) / (d.df + 0.5))
           * (t.tf * (${k1}::float8 + 1))
           / (t.tf + ${k1}::float8 * (1 - ${b}::float8 + ${b}::float8 * j.doc_len / c.avgdl))
         ) AS score
  FROM job_terms t
  JOIN df d USING (lexeme)
  JOIN jobs j ON j.id = t.job_id
  CROSS JOIN corpus c
  WHERE ${filterClause("j", p, f)}
  GROUP BY t.job_id
),
keyword AS (
  SELECT id, score, ROW_NUMBER() OVER (ORDER BY score DESC, id) AS rnk
  FROM bm25 ORDER BY score DESC, id LIMIT ${p.add(CANDIDATES)}
)`;
}

/**
 * Postgres' built-in ranker over the same OR-of-lexemes query, for comparison.
 * ts_rank counts weighted term hits with no IDF and (by default) no length
 * normalisation — common words and long documents are over-rewarded.
 */
function tsRankCte(p: Params, f: Filters): string {
  return `
tsq AS (
  SELECT string_agg(quote_literal(lexeme), ' | ')::tsquery AS q FROM qterms
),
keyword AS (
  SELECT j.id,
         ts_rank(j.fts, tsq.q) AS score,
         ROW_NUMBER() OVER (ORDER BY ts_rank(j.fts, tsq.q) DESC, j.id) AS rnk
  FROM jobs j CROSS JOIN tsq
  WHERE tsq.q IS NOT NULL AND j.fts @@ tsq.q AND ${filterClause("j", p, f)}
  ORDER BY score DESC, j.id
  LIMIT ${p.add(CANDIDATES)}
)`;
}

export function buildSearch(opts: SearchOptions): { sql: string; values: unknown[] } {
  const p = new Params();
  const ctes: string[] = [];
  const wantKeyword = opts.mode !== "semantic";
  const wantSemantic = opts.mode !== "keyword";

  if (wantKeyword) {
    ctes.push(queryTermsCte(p, opts.query));
    ctes.push(opts.lexical === "bm25" ? bm25Cte(p, opts.filters) : tsRankCte(p, opts.filters));
  }
  if (wantSemantic) {
    if (!opts.queryVector) throw new Error("queryVector required for semantic/hybrid search");
    ctes.push(semanticCte(p, opts.queryVector, opts.filters));
  }

  // Score: RRF for hybrid; the retriever's own score otherwise (so single-mode
  // scores stay interpretable: BM25 points / ts_rank / cosine similarity).
  const scoreExpr =
    opts.mode === "hybrid"
      ? (() => {
          const k = p.add(RRF_K);
          return `COALESCE(1.0 / (${k}::float8 + s.rnk), 0) + COALESCE(1.0 / (${k}::float8 + kw.rnk), 0)`;
        })()
      : opts.mode === "keyword"
        ? `kw.score`
        : `s.score`;

  const semJoin = wantSemantic ? `LEFT JOIN semantic s ON s.id = j.id` : `LEFT JOIN (SELECT NULL::bigint AS id, NULL::float8 AS score, NULL::bigint AS rnk) s ON FALSE`;
  const kwJoin = wantKeyword ? `LEFT JOIN keyword kw ON kw.id = j.id` : `LEFT JOIN (SELECT NULL::bigint AS id, NULL::float8 AS score, NULL::bigint AS rnk) kw ON FALSE`;

  const sql = `
WITH ${ctes.join(",\n")}
SELECT ${RESULT_COLUMNS},
  (${scoreExpr})::float8        AS score,
  s.rnk                          AS semantic_rank,
  kw.rnk                         AS keyword_rank,
  s.score::float8                AS cosine_similarity,
  kw.score::float8               AS keyword_score,
  s.rnk IS NOT NULL              AS semantic_hit,
  kw.rnk IS NOT NULL             AS keyword_hit
FROM jobs j
${semJoin}
${kwJoin}
WHERE s.id IS NOT NULL OR kw.id IS NOT NULL
ORDER BY score DESC, j.posted_at DESC NULLS LAST, j.id
LIMIT ${p.add(opts.limit)}`;

  return { sql, values: p.values };
}

/** Newest jobs with filters — what the UI shows before anyone types. */
export function buildLatest(filters: Filters, limit: number): { sql: string; values: unknown[] } {
  const p = new Params();
  const sql = `
SELECT ${RESULT_COLUMNS},
  NULL::float8 AS score, NULL::bigint AS semantic_rank, NULL::bigint AS keyword_rank,
  NULL::float8 AS cosine_similarity, NULL::float8 AS keyword_score,
  false AS semantic_hit, false AS keyword_hit
FROM jobs j
WHERE ${filterClause("j", p, filters)}
ORDER BY j.posted_at DESC NULLS LAST, j.id
LIMIT ${p.add(limit)}`;
  return { sql, values: p.values };
}

// ---------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------

export function parseBool(value: unknown): boolean | null {
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

export function parseList(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 10);
}

export const SENIORITY_LEVELS = ["intern", "junior", "mid", "senior", "lead", "principal", "manager"] as const;

export function parseFilters(q: Record<string, unknown>): Filters {
  const location = typeof q.location === "string" ? q.location.trim().slice(0, 80) : "";
  return {
    remote: parseBool(q.remote),
    visa: parseBool(q.visa),
    location: location || null,
    skills: parseList(q.skills),
    seniority: parseList(q.seniority).filter((s) => (SENIORITY_LEVELS as readonly string[]).includes(s)),
  };
}

export function parseMode(value: unknown): Mode {
  return value === "keyword" || value === "semantic" ? value : "hybrid";
}

export function parseLexical(value: unknown): Lexical {
  return value === "ts_rank" ? "ts_rank" : "bm25";
}
