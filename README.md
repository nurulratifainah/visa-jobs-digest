# Visa Jobs Digest 🛂💼

An autonomous agent built with the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/quickstart) that scans job boards for tech roles offering **visa sponsorship or relocation assistance**, verifies each posting by reading it, and writes a curated markdown digest — twice a week, hands-free.

Inspired by hand-curated newsletters like relocate.me's weekly digest, but fully automated and tailored to your own profile.

## How it works

```
jobs.config.json ──▶ prompt ──▶ Claude Agent SDK (query)
                                   │  WebSearch: scan job boards
                                   │  WebFetch:  open each posting & verify
                                   ▼
                            digests/YYYY-MM-DD.md
```

1. `jobs.config.json` describes who you are (target roles, stacks, destinations) and which boards to scan.
2. `src/index.ts` builds a research prompt and runs it through the Agent SDK's `query()` with only `WebSearch` and `WebFetch` tools enabled — the agent loops autonomously: search → open posting → verify the visa/relocation claim → collect.
3. The finished digest is written to `digests/<date>.md` (and `digests/LATEST.md`).
4. A GitHub Actions workflow runs the whole thing every **Monday and Thursday** and commits the digest back to the repo — so the repo itself is a living job feed.

## Setup

```bash
npm install
```

**Auth** — one of:

- **Locally**: if you use Claude Code, the SDK reuses your existing `claude` login — nothing to configure.
- **CI / headless**: set `ANTHROPIC_API_KEY` (create one at [platform.claude.com](https://platform.claude.com)).

## Run it

```bash
npm run digest
```

Progress streams to stderr; the digest lands in `digests/`.

Options via env vars:

| Variable | Default | Purpose |
|---|---|---|
| `CLAUDE_MODEL` | `claude-opus-4-8` | Model to run the agent on (e.g. `claude-sonnet-5` for cheaper runs) |

## Schedule it on GitHub

1. Push this repo to GitHub.
2. Add a repository secret `ANTHROPIC_API_KEY` (Settings → Secrets and variables → Actions).
3. Done — `.github/workflows/digest.yml` runs Mon/Thu at 08:00 MYT and commits each digest. You can also trigger it manually from the Actions tab (`workflow_dispatch`).

## Customize

Everything about *what* to search lives in `jobs.config.json`:

- `profiles` — the roles you (or your household!) are hunting for
- `destinations` — countries/regions you'd relocate to
- `sources` — job boards to scan
- `maxJobs` / `freshnessDays` — digest size and recency

No code changes needed to retarget the agent.

## Why the Agent SDK?

The Agent SDK is Claude Code packaged as a library: it ships the agentic loop, built-in tools (`WebSearch`, `WebFetch`, file ops, bash), permissions, and context management. This project is deliberately small — the "hard part" (multi-step autonomous research with verification) is entirely handled by `query()` with a well-specified prompt.

## License

MIT
