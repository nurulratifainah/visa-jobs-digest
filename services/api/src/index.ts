import express from "express";
import path from "node:path";
import fs from "node:fs";
import pg from "pg";
import { pipeline, env as hfEnv } from "@xenova/transformers";
import {
  buildLatest,
  buildSearch,
  parseFilters,
  parseLexical,
  parseMode,
  SENIORITY_LEVELS,
  type Lexical,
  type Mode,
} from "./search.js";

if (process.env.MODEL_CACHE_DIR || process.env.NODE_ENV === "production") {
  hfEnv.cacheDir = process.env.MODEL_CACHE_DIR ?? "/models";
}

const EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
const PORT = Number(process.env.PORT ?? 8080);

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

type Embedder = (text: string, opts: object) => Promise<{ data: Float32Array }>;
let embed: Embedder;

async function embedQuery(q: string): Promise<string> {
  // Same model, same pooling/normalisation as the indexer → same vector space.
  const output = await embed(q, { pooling: "mean", normalize: true });
  return JSON.stringify(Array.from(output.data));
}

function parseLimit(value: unknown, fallback = 20): number {
  const n = Number(value ?? fallback);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 50) : fallback;
}

const app = express();

/**
 * GET /api/search
 *   q          free text (omit → newest jobs)
 *   mode       hybrid (default) | keyword | semantic
 *   lexical    bm25 (default) | ts_rank        — which lexical ranker keyword/hybrid use
 *   remote     true | false
 *   visa       true | false
 *   location   substring, e.g. "berlin"
 *   skills     comma list, all required, e.g. "python,kubernetes"
 *   seniority  comma list, any of intern,junior,mid,senior,lead,principal,manager
 *   limit      ≤ 50
 */
app.get("/api/search", async (req, res) => {
  try {
    const q = String(req.query.q ?? "").trim();
    const filters = parseFilters(req.query as Record<string, unknown>);
    const limit = parseLimit(req.query.limit);
    const mode = parseMode(req.query.mode);
    const lexical = parseLexical(req.query.lexical);

    if (!q) {
      const { sql, values } = buildLatest(filters, limit);
      const { rows } = await pool.query(sql, values);
      res.json({ query: q, mode: "latest", filters, results: rows });
      return;
    }

    const started = performance.now();
    const queryVector = mode === "keyword" ? null : await embedQuery(q);
    const embedMs = performance.now() - started;

    const { sql, values } = buildSearch({ mode, lexical, query: q, queryVector, filters, limit });
    const { rows } = await pool.query(sql, values);
    res.json({
      query: q,
      mode,
      lexical: mode === "semantic" ? null : lexical,
      filters,
      took_ms: { embed: Math.round(embedMs), total: Math.round(performance.now() - started) },
      results: rows,
    });
  } catch (err) {
    console.error("[api] search error:", err);
    res.status(500).json({ error: "search failed" });
  }
});

/**
 * GET /api/compare — the same query through every retriever, side by side.
 * One embedding call, then one SQL statement per column. Used by the UI's
 * compare view and handy for eyeballing where each retriever wins.
 */
app.get("/api/compare", async (req, res) => {
  try {
    const q = String(req.query.q ?? "").trim();
    if (!q) {
      res.status(400).json({ error: "q is required" });
      return;
    }
    const filters = parseFilters(req.query as Record<string, unknown>);
    const limit = parseLimit(req.query.limit, 10);
    const lexical = parseLexical(req.query.lexical);
    const queryVector = await embedQuery(q);

    const columns: Array<{ mode: Mode; lexical: Lexical | null; label: string }> = [
      { mode: "keyword", lexical, label: lexical === "bm25" ? "Keyword · BM25" : "Keyword · ts_rank" },
      { mode: "semantic", lexical: null, label: "Semantic · cosine KNN" },
      { mode: "hybrid", lexical, label: `Hybrid · RRF(${lexical} + KNN)` },
    ];

    const results = await Promise.all(
      columns.map(async (col) => {
        const started = performance.now();
        const { sql, values } = buildSearch({
          mode: col.mode,
          lexical: col.lexical ?? "bm25",
          query: q,
          queryVector,
          filters,
          limit,
        });
        const { rows } = await pool.query(sql, values);
        return { ...col, took_ms: Math.round(performance.now() - started), results: rows };
      }),
    );

    res.json({ query: q, filters, columns: results });
  } catch (err) {
    console.error("[api] compare error:", err);
    res.status(500).json({ error: "compare failed" });
  }
});

app.get("/api/stats", async (_req, res) => {
  try {
    const [{ rows: totals }, { rows: seniority }] = await Promise.all([
      pool.query(
        `SELECT count(*)::int AS total,
                count(embedding)::int AS indexed,
                count(*) FILTER (WHERE visa_sponsorship)::int AS visa_friendly,
                count(*) FILTER (WHERE remote)::int AS remote,
                (SELECT count(*)::int FROM job_terms) AS bm25_postings,
                round(avg(doc_len))::int AS avg_doc_len,
                max(created_at) AS last_ingested_at
         FROM jobs`,
      ),
      pool.query(
        `SELECT coalesce(seniority, 'unknown') AS seniority, count(*)::int AS count
         FROM jobs GROUP BY 1 ORDER BY 2 DESC`,
      ),
    ]);
    res.json({
      ...totals[0],
      seniority: Object.fromEntries(seniority.map((r) => [r.seniority, r.count])),
      seniority_levels: SENIORITY_LEVELS,
    });
  } catch (err) {
    console.error("[api] stats error:", err);
    res.status(500).json({ error: "stats failed" });
  }
});

// Serve the built React frontend if present (production Docker image).
const webDist = process.env.WEB_DIST ?? path.resolve("web-dist");
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(webDist, "index.html")));
}

async function main(): Promise<void> {
  console.log(`[api] loading embedding model ${EMBEDDING_MODEL}...`);
  embed = (await pipeline("feature-extraction", EMBEDDING_MODEL)) as unknown as Embedder;
  app.listen(PORT, () => console.log(`[api] listening on :${PORT}`));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
