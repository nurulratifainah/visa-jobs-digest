/**
 * Runs the generated SQL against a real Postgres + pgvector, so BM25 maths,
 * the job_terms trigger and filter pushdown are exercised end to end.
 * Skipped unless TEST_DATABASE_URL is set (CI provides one; locally point it
 * at the compose db: TEST_DATABASE_URL=postgres://jobs:jobs@localhost:5434/jobs_test).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSearch, type Filters, type SearchOptions } from "../src/search.js";

const url = process.env.TEST_DATABASE_URL;
const here = path.dirname(fileURLToPath(import.meta.url));
const noFilters: Filters = { remote: null, visa: null, location: null, skills: [], seniority: [] };

/** One-hot-ish unit vectors so cosine similarity is predictable. */
function vector(axis: number): string {
  const v = Array(384).fill(0);
  v[axis] = 1;
  return JSON.stringify(v);
}

const JOBS = [
  { id: "backend-go", title: "Backend Engineer", tags: ["go", "postgres"], visa: true, remote: false, seniority: "mid", axis: 0,
    description: "Build APIs in Go on Postgres." },
  { id: "long-desc", title: "Office Manager", tags: [], visa: false, remote: true, seniority: "manager", axis: 1,
    description: ("We are a friendly team in Berlin looking for someone to run the office, order supplies, " +
      "plan events and support our engineer onboarding. ").repeat(4) },
  { id: "senior-py", title: "Senior Python Developer", tags: ["python", "kubernetes"], visa: true, remote: true, seniority: "senior", axis: 2,
    description: "Data pipelines with Python on Kubernetes. Visa sponsorship available." },
  { id: "frontend", title: "Frontend Engineer", tags: ["react"], visa: false, remote: true, seniority: "mid", axis: 3,
    description: "React and TypeScript." },
];

describe.skipIf(!url)("search SQL against Postgres", () => {
  const pool = new pg.Pool({ connectionString: url });

  async function search(opts: Partial<SearchOptions>): Promise<string[]> {
    const { sql, values } = buildSearch({
      mode: "keyword", lexical: "bm25", query: "", queryVector: null, filters: noFilters, limit: 10, ...opts,
    });
    const { rows } = await pool.query(sql, values);
    const ids = await pool.query<{ id: string; external_id: string }>("SELECT id, external_id FROM jobs");
    const byId = new Map(ids.rows.map((r) => [String(r.id), r.external_id]));
    return rows.map((r) => byId.get(String(r.id))!);
  }

  beforeAll(async () => {
    await pool.query("DROP TABLE IF EXISTS job_terms, jobs CASCADE");
    await pool.query(fs.readFileSync(path.resolve(here, "../../../db/init.sql"), "utf8"));
    for (const j of JOBS) {
      await pool.query(
        `INSERT INTO jobs (external_id, title, company, remote, visa_sponsorship, seniority, tags, description, embedding, posted_at)
         VALUES ($1, $2, 'Acme', $3, $4, $5, $6, $7, $8::vector, now())`,
        [j.id, j.title, j.remote, j.visa, j.seniority, j.tags, j.description, vector(j.axis)],
      );
    }
  });

  afterAll(async () => {
    await pool.end();
  });

  it("the trigger maintains the BM25 inverted index", async () => {
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM jobs WHERE doc_len IS NULL");
    expect(rows[0].n).toBe(0);
  });

  it("BM25 ranks a title match above a description that repeats the term", async () => {
    const bm25 = await search({ query: "engineer", lexical: "bm25" });
    expect(bm25.indexOf("backend-go")).toBeLessThan(bm25.indexOf("long-desc"));
  });

  it("keyword stuffing still wins — BM25 saturates tf but does not cap it", async () => {
    // Documents a known limitation rather than a desired property: 40 repeats
    // beat a 5x-weighted title hit. Worth a spam/quality signal in ranking.
    await pool.query(
      `INSERT INTO jobs (external_id, title, company, description) VALUES ('stuffed', 'Receptionist', 'Acme', $1)`,
      ["engineer ".repeat(40)],
    );
    try {
      const bm25 = await search({ query: "engineer" });
      expect(bm25.indexOf("stuffed")).toBeLessThan(bm25.indexOf("backend-go"));
    } finally {
      await pool.query("DELETE FROM jobs WHERE external_id = 'stuffed'");
    }
  });

  it("filters are applied inside the retriever", async () => {
    expect(await search({ query: "engineer developer", filters: { ...noFilters, visa: true } })).toEqual(
      expect.arrayContaining(["backend-go", "senior-py"]),
    );
    expect(await search({ query: "engineer developer", filters: { ...noFilters, visa: true } })).not.toContain("frontend");
  });

  it("skills filter requires every skill (tag or text)", async () => {
    const hits = await search({ query: "developer engineer", filters: { ...noFilters, skills: ["python", "kubernetes"] } });
    expect(hits).toEqual(["senior-py"]);
  });

  it("semantic mode returns the nearest vector first", async () => {
    const hits = await search({ mode: "semantic", queryVector: vector(3), query: "anything" });
    expect(hits[0]).toBe("frontend");
  });

  it("hybrid returns the union of both retrievers", async () => {
    // Keyword matches only Python; the vector points at Frontend. RRF should surface both.
    const hits = await search({ mode: "hybrid", query: "python", queryVector: vector(3) });
    expect(hits).toEqual(expect.arrayContaining(["senior-py", "frontend"]));
  });
});
