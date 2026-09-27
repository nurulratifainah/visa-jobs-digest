---
name: new-endpoint
description: Add a new HTTP endpoint to services/api following the house pattern (pure SQL builder in search.ts + thin route + tests). Use when asked to add or expose a new API route.
---

# Add an API endpoint

1. **Clarify the contract** from the request: method, path, query params,
   response shape, limits. If ambiguous, state your assumption in the PR.
2. **Pure builder first.** Add `buildX(...)` to `services/api/src/search.ts`
   (or a new pure module if unrelated to search). Use `Params` for every value
   and reuse `filterClause`/`parseFilters` if it filters jobs.
3. **Unit test** in `services/api/test/`: SQL shape, placeholder count equals
   `values.length`, user input never appears in the SQL string.
4. **Integration test** in `test/search.integration.test.ts` if it runs SQL.
5. **Route** in `services/api/src/index.ts`: parse → build → `pool.query` →
   `res.json`. Wrap in try/catch, log with `[api]` prefix, return a generic
   500. Add a JSDoc block listing params like the existing routes.
6. **Docs:** add a `curl` example to the README "Run it" section.
7. Run `npm test && npm run typecheck` in `services/api`.
