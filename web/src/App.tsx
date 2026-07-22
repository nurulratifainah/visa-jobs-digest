import { useCallback, useEffect, useState } from "react";

interface JobResult {
  id: number;
  title: string;
  company: string | null;
  location: string | null;
  remote: boolean;
  visa_sponsorship: boolean;
  tags: string[];
  url: string | null;
  posted_at: string | null;
  snippet: string | null;
  score: number | null;
  semantic_hit: boolean;
  keyword_hit: boolean;
}

interface Stats {
  total: number;
  indexed: number;
  visa_friendly: number;
  remote: number;
}

type TriState = "any" | "true" | "false";

export default function App() {
  const [query, setQuery] = useState("");
  const [remote, setRemote] = useState<TriState>("any");
  const [visa, setVisa] = useState<TriState>("any");
  const [results, setResults] = useState<JobResult[]>([]);
  const [mode, setMode] = useState("latest");
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(false);

  const search = useCallback(async (q: string, remoteF: TriState, visaF: TriState) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (q) params.set("q", q);
      if (remoteF !== "any") params.set("remote", remoteF);
      if (visaF !== "any") params.set("visa", visaF);
      const res = await fetch(`/api/search?${params}`);
      const body = await res.json();
      setResults(body.results ?? []);
      setMode(body.mode ?? "latest");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    search("", "any", "any");
    fetch("/api/stats")
      .then((r) => r.json())
      .then(setStats)
      .catch(() => {});
  }, [search]);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    search(query, remote, visa);
  };

  return (
    <div className="page">
      <header>
        <h1>Visa Jobs Search</h1>
        <p className="tagline">
          Hybrid semantic + keyword search over visa-friendly tech jobs.
          {stats && (
            <span className="stats">
              {" "}
              {stats.total} jobs · {stats.indexed} indexed · {stats.visa_friendly} visa-friendly
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
          Remote:
          <select value={remote} onChange={(e) => setRemote(e.target.value as TriState)}>
            <option value="any">Any</option>
            <option value="true">Remote only</option>
            <option value="false">On-site only</option>
          </select>
        </label>
        <label>
          Visa/relocation mentioned:
          <select value={visa} onChange={(e) => setVisa(e.target.value as TriState)}>
            <option value="any">Any</option>
            <option value="true">Yes</option>
          </select>
        </label>
        <span className="mode">mode: {mode}</span>
      </div>

      <ul className="results">
        {results.map((job) => (
          <li key={job.id} className="card">
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
              {job.remote && <span className="pill">remote</span>}
              {job.visa_sponsorship && <span className="pill visa">visa/relocation</span>}
            </p>
            {job.snippet && <p className="snippet">{job.snippet}…</p>}
            {job.tags.length > 0 && (
              <p className="tags">{job.tags.slice(0, 6).join(" · ")}</p>
            )}
          </li>
        ))}
        {!loading && results.length === 0 && <p className="empty">No results — is the pipeline still indexing?</p>}
      </ul>
    </div>
  );
}
