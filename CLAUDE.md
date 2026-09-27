# CLAUDE.md

Instructions for AI coding agents (Claude Code locally and in GitHub Actions).
Humans: this is also the shortest accurate tour of the codebase.

## What this is
Event-driven hybrid job search. `ingester` pulls ads → Postgres and emits
`job.created` to SQS → `indexer` embeds (MiniLM, 384-d) → `api` serves BM25 /
pgvector KNN / RRF hybrid → `web` (React). `agent/` is a separate Claude Agent
SDK digest job run by cron. Architecture: `docs/ARCHITECTURE.md`. Ranking maths
and eval results: `docs/SEARCH-NOTES.md`.

## Layout
| Path | Notes |
|---|---|
| `services/api/src/search.ts` | **All SQL for search.** Pure functions; no I/O. |
| `services/api/src/index.ts` | Express routes; thin — parse, call `search.ts`, return. |
| `services/api/src/eval.ts` | Offline relevance eval (P@K, R@K, MRR, nDCG). |
| `services/ingester/src/classify.ts` | Pure classifiers (seniority, visa, HTML cleaning). |
| `services/ingester/src/index.ts` | I/O loop: fetch, insert, publish, reconcile, backfill. |
| `services/indexer/src/index.ts` | SQS consumer; embeds and writes vectors. |
| `db/init.sql` | Schema + BM25 trigger. **Re-run against live DBs — must stay idempotent.** |

Each service is its own npm package (no workspace). Run commands inside the package dir.

## Commands
```bash
npm test                 # services/api, services/ingester (vitest)
npm run typecheck        # every package
TEST_DATABASE_URL=postgres://jobs:jobs@localhost:5434/jobs_test npm test   # + SQL integration tests (api)
docker compose up --build
docker compose exec api npm run eval          # relevance eval; needs a populated DB
```

## Rules
1. **Keep I/O out of pure modules.** New logic goes in a pure module
   (`search.ts`, `classify.ts`, or a new one) with a unit test; `index.ts`
   files only wire it up. Importing an `index.ts` starts the service.
2. **SQL values only via `Params.add()`.** Never interpolate user input.
3. **Filters go inside each retriever** (`filterClause`), never after fusion.
4. **Schema changes:** edit `db/init.sql` with `IF NOT EXISTS` / `CREATE OR
   REPLACE`, add a backfill if existing rows need it, and cover it in
   `test/search.integration.test.ts`.
5. **Ranking changes** (weights, K, tokenisation, fusion): run the eval before
   and after and paste both tables in the PR. No numbers, no merge.
6. **Consumers are idempotent.** SQS is at-least-once.
7. **Cap every input** (limits ≤ 50, list lengths, string lengths).
8. Tests first when fixing a bug: add the failing case, then fix.
9. Don't touch `agent/` or `.github/workflows/digest.yml` unless asked.

## Definition of done
- `npm test` and `npm run typecheck` pass in every package you touched
  (hooks in `.claude/settings.json` enforce this locally).
- New behaviour has a test. Bug fixes include the regression test.
- Docs updated if behaviour or commands changed.
- PR description filled in from `.github/pull_request_template.md`.

## Known issues / good first tasks
- `detectSeniority` misses German compounds (`Softwareentwickler (m/w/d)`) —
  see the `it.fails` test in `services/ingester/test/classify.test.ts`.
- BM25 does not resist keyword stuffing (integration test documents it).
