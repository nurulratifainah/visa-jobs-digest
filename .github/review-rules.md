# Review rules

Used by the AI reviewer (`.github/workflows/claude-review.yml`) and by humans.
Ordered by severity. Raise a finding only if you can name a concrete failure.

## Must fix
- **SQL built from user input.** Every value goes through `Params.add()` in
  `services/api/src/search.ts`. String-interpolated user input is a blocker.
- **Filters applied after fusion.** Filters belong inside each retriever CTE
  (`filterClause`), never on the fused list — post-filtering a top-60 list
  silently returns too few rows.
- **Non-idempotent consumers.** SQS is at-least-once. The indexer must be safe
  to run twice on the same message.
- **Schema changes not in `db/init.sql`, or not idempotent** (`IF NOT EXISTS`,
  `CREATE OR REPLACE`). The file is re-run against live databases.
- **Embedding mismatch.** Query and document embeddings must use the same model,
  pooling and normalisation (api vs indexer).
- **Secrets** in code, logs, or workflow files.

## Should fix
- Ranking changes (weights, K, fusion, tokenisation) without an
  `npm run eval` before/after in the PR description.
- New pure logic without a unit test; new SQL without an integration test.
- N+1 queries or per-row round-trips on a hot path.
- Errors swallowed without logging, or 500s that leak internals.
- Unbounded input: limits, list lengths and string lengths must be capped.

## Don't comment on
- Formatting and naming preferences with no behavioural effect.
- Code the PR did not change.
