---
name: add-eval-query
description: Add a query with relevance judgments to the offline eval set (services/api/eval/queries.json). Use when a search bug or a new query type should be tracked by the eval.
---

# Add an eval query

1. Read `services/api/eval/queries.json` to match the existing format
   (`query` + `relevant.title_regex` and/or `relevant.any_tags`).
2. Write judgments that describe *what a relevant job is*, not which IDs came
   back today — the corpus changes every ingest.
3. Sanity-check the relevant set size against the live DB (aim for 5–100
   matches): count rows in `jobs` matching the regex/tags.
4. Run `docker compose exec api npm run eval -- --verbose` and include the new
   query's row in the PR.
