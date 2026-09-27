---
name: ranking-change
description: Safely change search ranking (BM25 k1/b, field weights, RRF K, candidate count, tokenisation, fusion) with before/after relevance numbers. Use for any change that could alter result order.
---

# Change ranking, measured

1. Stack must be up with data: `docker compose up -d` and `curl
   localhost:8080/api/stats` shows `indexed` > 0.
2. **Baseline:** `docker compose exec api npm run eval -- --json > /tmp/before.json`
   and keep the summary table.
3. Make the change. Constants live at the top of `services/api/src/search.ts`;
   field weights live in the `jobs_sync_terms` trigger in `db/init.sql` (re-apply
   with `docker compose exec -T db psql -U jobs -d jobs < db/init.sql`).
4. `docker compose restart api`, then run the eval again → `/tmp/after.json`.
5. Report a before/after table of P@10, R@10, MRR, nDCG@10 and p50 latency for
   every config, plus 2–3 queries that moved most (`--verbose`).
6. If any config regresses by more than ~0.02 nDCG, say so plainly and explain
   the trade-off — don't bury it. Add a note to `docs/SEARCH-NOTES.md`.
