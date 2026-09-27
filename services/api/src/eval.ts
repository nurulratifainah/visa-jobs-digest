/**
 * Offline relevance evaluation: runs every query in eval/queries.json through
 * each retriever configuration and reports Precision@K, Recall@K, MRR and
 * nDCG@K, plus latency.
 *
 *   docker compose exec api npm run eval            # summary table
 *   docker compose exec api npm run eval -- --verbose   # per-query breakdown
 *   docker compose exec api npm run eval -- --k 20 --json
 *
 * Judgments are heuristic (title regex / tag membership, computed against the
 * live corpus) so absolute numbers are not comparable to published benchmarks.
 * Deltas between configurations *are* meaningful, and that is what this is
 * for: a regression check when you change tokenisation, weights, K, fusion.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

interface Judgment {
  title_regex?: string;
  any_tags?: string[];
}
interface EvalQuery {
  query: string;
  relevant: Judgment;
}
interface Config {
  label: string;
  params: Record<string, string>;
}
interface Hit {
  id: number;
}

const API_URL = process.env.API_URL ?? `http://localhost:${process.env.PORT ?? 8080}`;
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const K = Number(opt("k", "10"));

const CONFIGS: Config[] = [
  { label: "keyword/ts_rank", params: { mode: "keyword", lexical: "ts_rank" } },
  { label: "keyword/bm25", params: { mode: "keyword", lexical: "bm25" } },
  { label: "semantic", params: { mode: "semantic" } },
  { label: "hybrid/ts_rank", params: { mode: "hybrid", lexical: "ts_rank" } },
  { label: "hybrid/bm25", params: { mode: "hybrid", lexical: "bm25" } },
];

const here = path.dirname(fileURLToPath(import.meta.url));
const queriesPath = process.env.EVAL_QUERIES ?? path.resolve(here, "../eval/queries.json");
const { queries } = JSON.parse(fs.readFileSync(queriesPath, "utf8")) as { queries: EvalQuery[] };

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

/** Relevant set for a query, computed over the whole corpus. */
async function relevantIds(j: Judgment): Promise<Set<number>> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM jobs
     WHERE ($1::text IS NOT NULL AND title ~* $1)
        OR ($2::text[] IS NOT NULL AND tags && $2::text[])`,
    [j.title_regex ?? null, j.any_tags?.map((t) => t.toLowerCase()) ?? null],
  );
  return new Set(rows.map((r) => Number(r.id)));
}

async function ranked(query: string, cfg: Config): Promise<{ ids: number[]; ms: number }> {
  const params = new URLSearchParams({ q: query, limit: String(K), ...cfg.params });
  const started = performance.now();
  const res = await fetch(`${API_URL}/api/search?${params}`);
  if (!res.ok) throw new Error(`${cfg.label} "${query}": HTTP ${res.status}`);
  const body = (await res.json()) as { results: Hit[] };
  return { ids: body.results.map((r) => Number(r.id)), ms: performance.now() - started };
}

// --- metrics (binary relevance) ------------------------------------------------

function precisionAtK(ids: number[], rel: Set<number>): number {
  const top = ids.slice(0, K);
  return top.length === 0 ? 0 : top.filter((id) => rel.has(id)).length / K;
}
function recallAtK(ids: number[], rel: Set<number>): number {
  if (rel.size === 0) return 0;
  return ids.slice(0, K).filter((id) => rel.has(id)).length / Math.min(rel.size, K);
}
function mrr(ids: number[], rel: Set<number>): number {
  const i = ids.slice(0, K).findIndex((id) => rel.has(id));
  return i < 0 ? 0 : 1 / (i + 1);
}
/** nDCG@K with binary gains: DCG = Σ rel_i / log2(i+1), normalised by the ideal ordering. */
function ndcg(ids: number[], rel: Set<number>): number {
  const dcg = ids.slice(0, K).reduce((acc, id, i) => acc + (rel.has(id) ? 1 / Math.log2(i + 2) : 0), 0);
  const ideal = Array.from({ length: Math.min(rel.size, K) }, (_, i) => 1 / Math.log2(i + 2)).reduce((a, b) => a + b, 0);
  return ideal === 0 ? 0 : dcg / ideal;
}

interface Row {
  label: string;
  p: number;
  r: number;
  mrr: number;
  ndcg: number;
  p50: number;
  p95: number;
}

const pct = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0;
};
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const f = (x: number) => x.toFixed(3);

async function main(): Promise<void> {
  const judged = await Promise.all(
    queries.map(async (q) => ({ ...q, rel: await relevantIds(q.relevant) })),
  );
  const usable = judged.filter((q) => q.rel.size > 0);
  const skipped = judged.length - usable.length;

  const perQuery: Record<string, Array<{ query: string; nRel: number; p: number; r: number; mrr: number; ndcg: number }>> = {};
  const rows: Row[] = [];

  for (const cfg of CONFIGS) {
    const stats = { p: [] as number[], r: [] as number[], mrr: [] as number[], ndcg: [] as number[], ms: [] as number[] };
    perQuery[cfg.label] = [];
    for (const q of usable) {
      const { ids, ms } = await ranked(q.query, cfg);
      const m = { p: precisionAtK(ids, q.rel), r: recallAtK(ids, q.rel), mrr: mrr(ids, q.rel), ndcg: ndcg(ids, q.rel) };
      stats.p.push(m.p); stats.r.push(m.r); stats.mrr.push(m.mrr); stats.ndcg.push(m.ndcg); stats.ms.push(ms);
      perQuery[cfg.label].push({ query: q.query, nRel: q.rel.size, ...m });
    }
    rows.push({
      label: cfg.label,
      p: mean(stats.p), r: mean(stats.r), mrr: mean(stats.mrr), ndcg: mean(stats.ndcg),
      p50: pct(stats.ms, 0.5), p95: pct(stats.ms, 0.95),
    });
  }

  const { rows: [corpus] } = await pool.query<{ total: string; indexed: string }>(
    "SELECT count(*) AS total, count(embedding) AS indexed FROM jobs",
  );

  if (flag("json")) {
    console.log(JSON.stringify({ k: K, corpus, queries: usable.length, skipped, summary: rows, perQuery }, null, 2));
  } else {
    console.log(`\nCorpus: ${corpus.total} jobs (${corpus.indexed} embedded) · ${usable.length} queries · K=${K}` +
      (skipped ? ` · ${skipped} skipped (no relevant docs in corpus)` : ""));
    console.log(`\n| config | P@${K} | R@${K} | MRR | nDCG@${K} | p50 ms | p95 ms |`);
    console.log(`|---|---|---|---|---|---|---|`);
    for (const r of rows) {
      console.log(`| ${r.label} | ${f(r.p)} | ${f(r.r)} | ${f(r.mrr)} | ${f(r.ndcg)} | ${r.p50.toFixed(0)} | ${r.p95.toFixed(0)} |`);
    }
    if (flag("verbose")) {
      for (const cfg of CONFIGS) {
        console.log(`\n### ${cfg.label}\n\n| query | #rel | P@${K} | R@${K} | MRR | nDCG |\n|---|---|---|---|---|---|`);
        for (const q of perQuery[cfg.label]) {
          console.log(`| ${q.query} | ${q.nRel} | ${f(q.p)} | ${f(q.r)} | ${f(q.mrr)} | ${f(q.ndcg)} |`);
        }
      }
    }
    console.log();
  }
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
