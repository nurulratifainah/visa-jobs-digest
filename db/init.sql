CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS jobs (
  id               BIGSERIAL PRIMARY KEY,
  external_id      TEXT UNIQUE NOT NULL,
  title            TEXT NOT NULL,
  company          TEXT,
  location         TEXT,
  remote           BOOLEAN NOT NULL DEFAULT FALSE,
  visa_sponsorship BOOLEAN NOT NULL DEFAULT FALSE,
  -- Derived at ingest from the title: intern | junior | mid | senior | lead | principal | manager
  seniority        TEXT,
  tags             TEXT[] NOT NULL DEFAULT '{}',
  url              TEXT,
  description      TEXT,
  posted_at        TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  indexed_at       TIMESTAMPTZ,
  embedding        vector(384),
  fts              tsvector GENERATED ALWAYS AS (
                     setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
                     setweight(to_tsvector('english', coalesce(company, '')), 'B') ||
                     setweight(to_tsvector('english', coalesce(description, '')), 'C')
                   ) STORED,
  -- Field-weighted token count of `fts` (sum of weighted tf). BM25's length normalisation needs it.
  doc_len          INTEGER
);

-- Idempotent migration path for databases created before these columns existed
-- (docker-entrypoint only runs this file on an empty volume):
--   docker compose exec -T db psql -U jobs -d jobs < db/init.sql
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS seniority TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS doc_len INTEGER;

CREATE INDEX IF NOT EXISTS jobs_fts_idx ON jobs USING GIN (fts);
CREATE INDEX IF NOT EXISTS jobs_embedding_idx ON jobs USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS jobs_posted_at_idx ON jobs (posted_at DESC);
-- Filter indexes: skills are matched against tags with array containment (@>), which GIN serves.
CREATE INDEX IF NOT EXISTS jobs_tags_idx ON jobs USING GIN (tags);
CREATE INDEX IF NOT EXISTS jobs_seniority_idx ON jobs (seniority);
-- Reconciler: "jobs still unindexed" is a tiny partial index instead of a table scan.
CREATE INDEX IF NOT EXISTS jobs_unindexed_idx ON jobs (created_at) WHERE embedding IS NULL;

-- ---------------------------------------------------------------------------
-- BM25 support: an inverted index of (job, lexeme, term frequency).
--
-- Postgres' ts_rank is NOT BM25: it has no inverse-document-frequency term and
-- its length normalisation is optional and crude. To rank with real BM25 we
-- need, per document, each lexeme's term frequency (tf) and the document
-- length; per corpus, the document count (N) and average length (avgdl); per
-- query term, the number of documents containing it (df).
--
-- `unnest(tsvector)` yields (lexeme, positions[], weights[]) — the same stemmed,
-- stop-word-filtered lexemes the FTS index uses, so BM25 and ts_rank score the
-- exact same tokens and can be compared fairly.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS job_terms (
  job_id  BIGINT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  lexeme  TEXT   NOT NULL,
  tf      INTEGER NOT NULL,
  PRIMARY KEY (job_id, lexeme)
);
-- Query path is "all postings for these lexemes" → index the posting list by lexeme.
CREATE INDEX IF NOT EXISTS job_terms_lexeme_idx ON job_terms (lexeme);

CREATE OR REPLACE FUNCTION jobs_sync_terms() RETURNS trigger AS $$
BEGIN
  DELETE FROM job_terms WHERE job_id = NEW.id;
  -- Field-weighted term frequency (a BM25F approximation): a title hit counts
  -- 5x, company 2x, description 1x. Without this a long description that
  -- repeats "engineer" outranks a job literally titled "Backend Engineer".
  INSERT INTO job_terms (job_id, lexeme, tf)
    SELECT NEW.id, t.lexeme,
           sum(CASE w WHEN 'A' THEN 5 WHEN 'B' THEN 2 ELSE 1 END)::int
    FROM unnest(NEW.fts) AS t
    CROSS JOIN unnest(coalesce(t.weights, ARRAY['D'])) AS w
    GROUP BY t.lexeme;
  -- Only doc_len is touched, and the trigger only fires on the text columns,
  -- so this UPDATE does not re-enter the trigger.
  UPDATE jobs
     SET doc_len = (SELECT coalesce(sum(tf), 0) FROM job_terms WHERE job_id = NEW.id)
   WHERE id = NEW.id;
  RETURN NULL;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS jobs_sync_terms_trg ON jobs;
CREATE TRIGGER jobs_sync_terms_trg
  AFTER INSERT OR UPDATE OF title, company, description ON jobs
  FOR EACH ROW EXECUTE FUNCTION jobs_sync_terms();

-- ---------------------------------------------------------------------------
-- Backfills (no-ops on a fresh database)
-- ---------------------------------------------------------------------------
-- Tags are stored lower-cased so the skills filter can use array containment.
UPDATE jobs
   SET tags = (SELECT coalesce(array_agg(DISTINCT lower(t)), '{}') FROM unnest(tags) AS t)
 WHERE tags <> (SELECT coalesce(array_agg(DISTINCT lower(t)), '{}') FROM unnest(tags) AS t);

-- Populate job_terms/doc_len for rows that predate the trigger. UPDATE OF title
-- fires the trigger even when the value is unchanged.
UPDATE jobs SET title = title WHERE doc_len IS NULL;
