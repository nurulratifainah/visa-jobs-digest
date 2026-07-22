import express from "express";
import path from "node:path";
import fs from "node:fs";
import pg from "pg";
import { pipeline, env as hfEnv } from "@xenova/transformers";

if (process.env.MODEL_CACHE_DIR || process.env.NODE_ENV === "production") {
  hfEnv.cacheDir = process.env.MODEL_CACHE_DIR ?? "/models";
}

const EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
const PORT = Number(process.env.PORT ?? 8080);
const RRF_K = 60; // standard reciprocal-rank-fusion constant
const CANDIDATES = 60; // candidates per retriever before fusion

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

type Embedder = (text: string, opts: object) => Promise<{ data: Float32Array }>;
let embed: Embedder;

const HYBRID_SEARCH_SQL = `
WITH semantic AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY embedding <=> $1::vector) AS rnk
  FROM jobs
  WHERE embedding IS NOT NULL
  ORDER BY embedding <=> $1::vector
  LIMIT $2
),
keyword AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY ts_rank(fts, websearch_to_tsquery('english', $3)) DESC) AS rnk
  FROM jobs
  WHERE fts @@ websearch_to_tsquery('english', $3)
  LIMIT $2
)
SELECT
  j.id, j.title, j.company, j.location, j.remote, j.visa_sponsorship,
  j.tags, j.url, j.posted_at, left(j.description, 280) AS snippet,
  COALESCE(1.0 / ($4 + semantic.rnk), 0) + COALESCE(1.0 / ($4 + keyword.rnk), 0) AS score,
  semantic.rnk IS NOT NULL AS semantic_hit,
  keyword.rnk IS NOT NULL AS keyword_hit
FROM jobs j
LEFT JOIN semantic ON semantic.id = j.id
LEFT JOIN keyword ON keyword.id = j.id
WHERE (semantic.id IS NOT NULL OR keyword.id IS NOT NULL)
  AND ($5::boolean IS NULL OR j.remote = $5)
  AND ($6::boolean IS NULL OR j.visa_sponsorship = $6)
ORDER BY score DESC
LIMIT $7`;

function parseBoolFilter(value: unknown): boolean | null {
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

const app = express();

app.get("/api/search", async (req, res) => {
  try {
    const q = String(req.query.q ?? "").trim();
    const remote = parseBoolFilter(req.query.remote);
    const visa = parseBoolFilter(req.query.visa);
    const limit = Math.min(Number(req.query.limit ?? 20), 50);

    if (!q) {
      // No query: newest jobs, filters still apply.
      const { rows } = await pool.query(
        `SELECT id, title, company, location, remote, visa_sponsorship, tags, url, posted_at,
                left(description, 280) AS snippet,
                NULL::float AS score, false AS semantic_hit, false AS keyword_hit
         FROM jobs
         WHERE ($1::boolean IS NULL OR remote = $1)
           AND ($2::boolean IS NULL OR visa_sponsorship = $2)
         ORDER BY posted_at DESC NULLS LAST
         LIMIT $3`,
        [remote, visa, limit],
      );
      res.json({ query: q, mode: "latest", results: rows });
      return;
    }

    const output = await embed(q, { pooling: "mean", normalize: true });
    const queryVector = JSON.stringify(Array.from(output.data));

    const { rows } = await pool.query(HYBRID_SEARCH_SQL, [
      queryVector,
      CANDIDATES,
      q,
      RRF_K,
      remote,
      visa,
      limit,
    ]);
    res.json({ query: q, mode: "hybrid", results: rows });
  } catch (err) {
    console.error("[api] search error:", err);
    res.status(500).json({ error: "search failed" });
  }
});

app.get("/api/stats", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS total,
              count(embedding)::int AS indexed,
              count(*) FILTER (WHERE visa_sponsorship)::int AS visa_friendly,
              count(*) FILTER (WHERE remote)::int AS remote,
              max(created_at) AS last_ingested_at
       FROM jobs`,
    );
    res.json(rows[0]);
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
