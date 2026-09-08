import { useCallback, useEffect, useState } from "react";

interface JobResult {
  id: number;
  title: string;
  company: string | null;
  location: string | null;
  remote: boolean;
  visa_sponsorship: boolean;
  seniority: string | null;
  tags: string[];
  url: string | null;
  posted_at: string | null;
  snippet: string | null;
  score: number | null;
  semantic_rank: number | null;
  keyword_rank: number | null;
  cosine_similarity: number | null;
  keyword_score: number | null;
  semantic_hit: boolean;
  keyword_hit: boolean;
}

interface Stats {
  total: number;
  indexed: number;
  visa_friendly: number;
  remote: number;
  bm25_postings: number;
  seniority_levels: string[];
}

interface CompareColumn {
  mode: Mode;
  lexical: Lexical | null;
  label: string;
  took_ms: number;
  results: JobResult[];
}

type TriState = "any" | "true" | "false";
type Mode = "hybrid" | "keyword" | "semantic";
type Lexical = "bm25" | "ts_rank";
type View = Mode | "compare";

interface FilterState {
  remote: TriState;
  visa: TriState;
  location: string;
  skills: string;
  seniority: string;
}

const DEFAULT_FILTERS: FilterState = { remote: "any", visa: "any", location: "", skills: "", seniority: "" };
const SENIORITY = ["intern", "junior", "mid", "senior", "lead", "principal", "manager"];

function filterParams(f: FilterState): URLSearchParams {
  const params = new URLSearchParams();
  if (f.remote !== "any") params.set("remote", f.remote);
  if (f.visa !== "any") params.set("visa", f.visa);
  if (f.location.trim()) params.set("location", f.location.trim());
  if (f.skills.trim()) params.set("skills", f.skills.trim());
  if (f.seniority) params.set("seniority", f.seniority);
  return params;
}

export default function App() {
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);
  const [view, setView] = useState<View>("hybrid");
  const [lexical, setLexical] = useState<Lexical>("bm25");
  const [results, setResults] = useState<JobResult[]>([]);
  const [compare, setCompare] = useState<CompareColumn[] | null>(null);
  const [mode, setMode] = useState("latest");
  const [tookMs, setTookMs] = useState<number | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(false);

  const search = useCallback(async (q: string, f: FilterState, v: View, lex: Lexical) => {
    setLoading(true);
    try {
      const params = filterParams(f);
      params.set("lexical", lex);
      if (q && v === "compare") {
        params.set("q", q);
        const res = await fetch(`/api/compare?${params}`);
        const body = await res.json();
        setCompare(body.columns ?? []);
        setResults([]);
        setMode("compare");
        setTookMs(null);
        return;
      }
      if (q) {
        params.set("q", q);
        params.set("mode", v);
      }
      const res = await fetch(`/api/search?${params}`);
      const body = await res.json();
      setCompare(null);
      setResults(body.results ?? []);
      setMode(body.mode ?? "latest");
      setTookMs(body.took_ms?.total ?? null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    search("", DEFAULT_FILTERS, "hybrid", "bm25");
    fetch("/api/stats")
      .then((r) => r.json())
      .then(setStats)
      .catch(() => {});
  }, [search]);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    search(query, filters, view, lexical);
  };

  const setFilter = <K extends keyof FilterState>(key: K, value: FilterState[K]) =>
    setFilters((f) => ({ ...f, [key]: value }));

  return (
    <div className={`page ${compare ? "wide" : ""}`}>
      <header>
        <h1>Visa Jobs Search</h1>
        <p className="tagline">
          Hybrid search over visa-friendly tech jobs — BM25 + vector KNN fused with RRF.
          {stats && (
            <span className="stats">
              {" "}
              {stats.total} jobs · {stats.indexed} embedded · {stats.bm25_postings.toLocaleString()} BM25 postings ·{" "}
              {stats.visa_friendly} visa-friendly
            </span>
          )}
        </p>
      </header>

      <form onSubmit={onSubmit} className="search-bar">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder='Try "backend engineer who works with search infrastructure"'
          autoFocus
        />
        <button type="submit" disabled={loading}>
          {loading ? "Searching…" : "Search"}
        </button>
      </form>

      <div className="filters">
        <label>
          Retriever
          <select value={view} onChange={(e) => setView(e.target.value as View)}>
            <option value="hybrid">Hybrid (RRF)</option>
            <option value="keyword">Keyword only</option>
            <option value="semantic">Semantic only</option>
            <option value="compare">Compare side by side</option>
          </select>
        </label>
        <label>
          Lexical ranker
          <select value={lexical} onChange={(e) => setLexical(e.target.value as Lexical)} disabled={view === "semantic"}>
            <option value="bm25">BM25 (SQL)</option>
            <option value="ts_rank">ts_rank (Postgres)</option>
          </select>
        </label>
        <span className="mode">
          mode: {mode}
          {tookMs !== null && ` · ${tookMs} ms`}
        </span>
      </div>

      <div className="filters">
        <label>
          Remote
          <select value={filters.remote} onChange={(e) => setFilter("remote", e.target.value as TriState)}>
            <option value="any">Any</option>
            <option value="true">Remote only</option>
            <option value="false">On-site only</option>
          </select>
        </label>
        <label>
          Visa/relocation
          <select value={filters.visa} onChange={(e) => setFilter("visa", e.target.value as TriState)}>
            <option value="any">Any</option>
            <option value="true">Mentioned</option>
          </select>
        </label>
        <label>
          Seniority
          <select value={filters.seniority} onChange={(e) => setFilter("seniority", e.target.value)}>
            <option value="">Any</option>
            {(stats?.seniority_levels ?? SENIORITY).map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label>
          Location
          <input
            className="small"
            value={filters.location}
            onChange={(e) => setFilter("location", e.target.value)}
            placeholder="berlin"
          />
        </label>
        <label>
          Skills
          <input
            className="small"
            value={filters.skills}
            onChange={(e) => setFilter("skills", e.target.value)}
            placeholder="python, kubernetes"
          />
        </label>
      </div>

      {compare ? (
        <CompareView columns={compare} />
      ) : (
        <ul className="results">
          {results.map((job) => (
            <JobCard key={job.id} job={job} mode={mode} />
          ))}
          {!loading && results.length === 0 && (
            <p className="empty">No results — try loosening a filter, or is the pipeline still indexing?</p>
          )}
        </ul>
      )}
    </div>
  );
}

/** One line explaining why a result ranked: RRF total plus each retriever's rank and raw score. */
function Why({ job, mode }: { job: JobResult; mode: string }) {
  if (job.score === null) return null;
  const parts: string[] = [];
  if (mode === "hybrid") parts.push(`rrf ${job.score.toFixed(4)}`);
  if (job.keyword_rank !== null) parts.push(`keyword #${job.keyword_rank} (${job.keyword_score?.toFixed(2)})`);
  if (job.semantic_rank !== null) parts.push(`vector #${job.semantic_rank} (cos ${job.cosine_similarity?.toFixed(3)})`);
  return <p className="why">{parts.join(" · ")}</p>;
}

function JobCard({ job, mode }: { job: JobResult; mode: string }) {
  return (
    <li className="card">
      <div className="card-head">
        <a href={job.url ?? "#"} target="_blank" rel="noreferrer">
          <h2>{job.title}</h2>
        </a>
        {job.score !== null && (
          <span className="badges">
            {job.semantic_hit && <span className="badge semantic">semantic</span>}
            {job.keyword_hit && <span className="badge keyword">keyword</span>}
          </span>
        )}
      </div>
      <p className="meta">
        {job.company} · {job.location || "—"}
        {job.seniority && <span className="pill level">{job.seniority}</span>}
        {job.remote && <span className="pill">remote</span>}
        {job.visa_sponsorship && <span className="pill visa">visa/relocation</span>}
      </p>
      <Why job={job} mode={mode} />
      {job.snippet && <p className="snippet">{job.snippet}…</p>}
      {job.tags.length > 0 && <p className="tags">{job.tags.slice(0, 6).join(" · ")}</p>}
    </li>
  );
}

/**
 * Side-by-side view. A result is highlighted when it appears in only one
 * column — those are the cases where retriever choice actually changes what
 * the user sees.
 */
function CompareView({ columns }: { columns: CompareColumn[] }) {
  const counts = new Map<number, number>();
  for (const col of columns) for (const r of col.results) counts.set(r.id, (counts.get(r.id) ?? 0) + 1);

  return (
    <div className="compare">
      {columns.map((col) => (
        <section key={col.label} className="column">
          <h3>
            {col.label} <span className="took">{col.took_ms} ms</span>
          </h3>
          <ol>
            {col.results.map((job) => (
              <li key={job.id} className={`mini ${counts.get(job.id) === 1 ? "unique" : ""}`}>
                <a href={job.url ?? "#"} target="_blank" rel="noreferrer">
                  {job.title}
                </a>
                <span className="mini-meta">
                  {job.company}
                  {job.seniority && ` · ${job.seniority}`}
                </span>
                <span className="mini-score">
                  {col.mode === "hybrid"
                    ? `rrf ${job.score?.toFixed(4)}${job.keyword_rank ? ` · k#${job.keyword_rank}` : ""}${job.semantic_rank ? ` · v#${job.semantic_rank}` : ""}`
                    : col.mode === "keyword"
                      ? `${col.lexical} ${job.score?.toFixed(2)}`
                      : `cos ${job.score?.toFixed(3)}`}
                </span>
              </li>
            ))}
            {col.results.length === 0 && <li className="mini empty">no matches</li>}
          </ol>
        </section>
      ))}
    </div>
  );
}
