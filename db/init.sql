CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS jobs (
  id               BIGSERIAL PRIMARY KEY,
  external_id      TEXT UNIQUE NOT NULL,
  title            TEXT NOT NULL,
  company          TEXT,
  location         TEXT,
  remote           BOOLEAN NOT NULL DEFAULT FALSE,
  visa_sponsorship BOOLEAN NOT NULL DEFAULT FALSE,
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
                   ) STORED
);

CREATE INDEX IF NOT EXISTS jobs_fts_idx ON jobs USING GIN (fts);
CREATE INDEX IF NOT EXISTS jobs_embedding_idx ON jobs USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS jobs_posted_at_idx ON jobs (posted_at DESC);
