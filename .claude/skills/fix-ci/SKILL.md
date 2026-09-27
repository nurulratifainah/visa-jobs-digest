---
name: fix-ci
description: Diagnose and fix a failing GitHub Actions run for this repo. Use when CI is red, a check failed on a PR, or given a run URL/ID.
---

# Fix failing CI

1. Find the run: `gh run list --branch <branch> --limit 5`, then
   `gh run view <id> --log-failed`. Identify the job (typecheck/test) and package.
2. **Reproduce locally** in that package before changing anything:
   `npm ci && npm run typecheck` or `npm test`. For the api integration tests,
   start pgvector: `docker run -d --rm -p 55432:5432 -e POSTGRES_USER=jobs
   -e POSTGRES_PASSWORD=jobs -e POSTGRES_DB=jobs_test pgvector/pgvector:pg16`
   and set `TEST_DATABASE_URL=postgres://jobs:jobs@localhost:55432/jobs_test`.
3. Classify the failure: real bug, stale test, flaky/environmental, or
   dependency drift. Say which in the PR.
4. Fix the cause. **Never** skip, delete, or loosen a test just to go green —
   if a test is wrong, explain why in the commit message.
5. Re-run locally, push, and confirm with `gh run watch`.
