import { describe, expect, it } from "vitest";
import {
  buildLatest,
  buildSearch,
  CANDIDATES,
  parseFilters,
  parseLexical,
  parseList,
  parseMode,
  RRF_K,
  type Filters,
} from "../src/search.js";

const noFilters: Filters = { remote: null, visa: null, location: null, skills: [], seniority: [] };
const vec = JSON.stringify(Array(384).fill(0));

describe("request parsing", () => {
  it("defaults unknown mode/lexical to hybrid/bm25", () => {
    expect(parseMode("nonsense")).toBe("hybrid");
    expect(parseMode("semantic")).toBe("semantic");
    expect(parseLexical(undefined)).toBe("bm25");
    expect(parseLexical("ts_rank")).toBe("ts_rank");
  });

  it("normalises and caps comma lists", () => {
    expect(parseList(" Python, ,KUBERNETES ")).toEqual(["python", "kubernetes"]);
    expect(parseList(Array(20).fill("x").join(","))).toHaveLength(10);
    expect(parseList(["python"])).toEqual([]); // repeated query params arrive as arrays
  });

  it("drops unknown seniority levels and trims location", () => {
    const f = parseFilters({ seniority: "senior,wizard", location: "  Berlin ", visa: "true", remote: "maybe" });
    expect(f).toEqual({ remote: null, visa: true, location: "Berlin", skills: [], seniority: ["senior"] });
  });
});

describe("buildSearch", () => {
  it("keyword mode never embeds and has no semantic CTE", () => {
    const { sql } = buildSearch({ mode: "keyword", lexical: "bm25", query: "go", queryVector: null, filters: noFilters, limit: 10 });
    expect(sql).toContain("bm25 AS");
    expect(sql).not.toContain("semantic AS");
  });

  it("semantic/hybrid require a query vector", () => {
    expect(() =>
      buildSearch({ mode: "hybrid", lexical: "bm25", query: "go", queryVector: null, filters: noFilters, limit: 10 }),
    ).toThrow(/queryVector/);
  });

  it("hybrid fuses both retrievers with RRF", () => {
    const { sql, values } = buildSearch({ mode: "hybrid", lexical: "bm25", query: "go", queryVector: vec, filters: noFilters, limit: 10 });
    expect(sql).toContain("semantic AS");
    expect(sql).toContain("keyword AS");
    expect(values).toContain(RRF_K);
    expect(values).toContain(CANDIDATES);
  });

  it("pushes filters into every retriever, not after fusion", () => {
    const filters: Filters = { ...noFilters, visa: true };
    const { sql } = buildSearch({ mode: "hybrid", lexical: "bm25", query: "go", queryVector: vec, filters, limit: 10 });
    expect(sql.match(/visa_sponsorship = \$\d+::boolean/g)).toHaveLength(2);
  });

  it("never interpolates user input into SQL", () => {
    const evil = "'; DROP TABLE jobs; --";
    const filters: Filters = { ...noFilters, location: evil, skills: [evil] };
    const { sql, values } = buildSearch({ mode: "keyword", lexical: "ts_rank", query: evil, queryVector: null, filters, limit: 10 });
    expect(sql).not.toContain("DROP TABLE");
    expect(values).toContain(evil);
  });

  it("placeholders line up with values", () => {
    const filters: Filters = { remote: true, visa: false, location: "berlin", skills: ["go"], seniority: ["senior"] };
    const { sql, values } = buildSearch({ mode: "hybrid", lexical: "bm25", query: "go", queryVector: vec, filters, limit: 5 });
    const maxPlaceholder = Math.max(...[...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
    expect(maxPlaceholder).toBe(values.length);
  });
});

describe("buildLatest", () => {
  it("orders by recency and applies filters", () => {
    const { sql, values } = buildLatest({ ...noFilters, remote: true }, 20);
    expect(sql).toMatch(/ORDER BY j\.posted_at DESC/);
    expect(values).toEqual([true, 20]);
  });
});
