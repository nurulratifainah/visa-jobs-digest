# AI-first development workflow

How this repo is built with AI agents: what they do, what stops them doing
damage, and what I learned. The short version: **agents do the typing; the
repo's tests, types, rules and reviewers decide what's allowed to merge.**

```
            ┌──────────── local (Claude Code) ───────────┐
 idea ──▶   │ CLAUDE.md + skills ──▶ agent edits code     │
            │   ├─ PostToolUse: typecheck the package     │ ◀─ errors fed back
            │   ├─ PreToolUse:  block push-to-main, -f    │    to the agent
            │   └─ Stop:        tests must pass           │
            └─────────────────────┬───────────────────────┘
                                  │  PR
 issue ──(@claude / `agent` label)─┤
            ┌─────────────────────▼──── GitHub ───────────┐
            │ CI: typecheck × 5 pkgs, unit + pgvector tests│  required
            │ AI review: .github/review-rules.md, inline   │  advisory
            │ Human review                                 │  required
            └─────────────────────┬───────────────────────┘
                                  ▼
                                merge
```

## The pieces

| Stage | What | Where |
|---|---|---|
| **Context** | One file every agent reads: architecture, rules, commands, definition of done | [`CLAUDE.md`](../CLAUDE.md) |
| **Coding** | Reusable playbooks for recurring tasks | [`.claude/skills/`](../.claude/skills) — `new-endpoint`, `ranking-change`, `add-eval-query`, `fix-ci` |
| **Fast feedback** | Typecheck after every edit; errors go straight back to the agent | [`.claude/hooks/typecheck-on-edit.sh`](../.claude/hooks/typecheck-on-edit.sh) |
| **Testing** | Agent can't finish its turn with red tests in a package it touched | [`.claude/hooks/tests-before-done.sh`](../.claude/hooks/tests-before-done.sh) |
| **Guardrails** | Deterministic blocks: force-push, push to main, reading `.env`, wiping volumes | [`.claude/hooks/guard-bash.sh`](../.claude/hooks/guard-bash.sh), `permissions.deny` |
| **CI** | Typecheck every package; unit tests; SQL integration tests on real pgvector | [`ci.yml`](../.github/workflows/ci.yml) |
| **Code review** | AI first-pass review on every PR against repo-specific rules, as inline comments | [`claude-review.yml`](../.github/workflows/claude-review.yml), [`review-rules.md`](../.github/review-rules.md) |
| **Issue → PR** | `@claude` on an issue/PR, or label an issue `agent` → branch + PR | [`claude.yml`](../.github/workflows/claude.yml) |
| **Debugging** | `@claude /fix-ci` on a red PR: reads failed logs, reproduces, fixes | `fix-ci` skill + `actions: read` |
| **Docs** | Skills require README/docs updates as part of "done"; PR template asks for AI involvement | skills, [`pull_request_template.md`](../.github/pull_request_template.md) |

## Design decisions

- **Hooks over instructions for anything that matters.** "Please run the
  tests" in a prompt is a suggestion; a Stop hook that exits 2 is a rule.
  `CLAUDE.md` explains *why*; hooks and CI *enforce*.
- **The AI reviewer is advisory, never a gate.** It comments; branch protection
  requires green CI and a human approval. Agent-authored PRs get no shortcut.
- **Review rules are repo-specific.** Generic "check for bugs" prompts produce
  generic nits. `review-rules.md` lists the failure modes *this* codebase has
  actually had (post-fusion filtering, non-idempotent consumers, interpolated
  SQL) and explicitly lists what not to comment on.
- **Tight tool allowlists in CI.** The review job can read and comment, nothing
  else. The agent job can edit and run `npm`/`git`, but not arbitrary shell.
  Only repo collaborators can trigger it — on a public repo, strangers must not
  be able to spend the API key or push branches.
- **Pure modules make agents better.** Splitting `classify.ts` out of the
  ingester's I/O loop made it testable, and testable code is code an agent can
  change safely: it gets a fast, deterministic signal on every edit.
- **Relevance is measured, not eyeballed.** Ranking changes must include
  before/after eval numbers (`ranking-change` skill). An agent will happily
  "improve" ranking by feel otherwise.

## What the tests found on day one

Adding the test suite (itself agent-assisted) immediately surfaced two things
that code review had missed:

1. **`detectSeniority("Softwareentwickler (m/w/d)")` returns `null`.** `\b`
   doesn't match inside German compounds or before `(`. Recorded as an
   `it.fails` test and left as the first issue for the `@claude` workflow.
2. **BM25 does not resist keyword stuffing.** A description repeating
   "engineer" 40 times outranks a job *titled* "Backend Engineer", despite the
   5× title weight: saturation slows tf growth but doesn't cap it. Documented
   in an integration test; a quality/spam feature is the real fix.

## When I don't use the agent

- Designing the ranking approach and interpreting eval results — the agent
  proposes, I decide.
- Anything touching secrets, infra credentials, or data deletion.
- When I can't state how I'd verify the result. No verification plan → no
  delegation.

## Running it yourself

1. Add `ANTHROPIC_API_KEY` as a repo secret, install the Claude GitHub App
   (`/install-github-app` in Claude Code does both).
2. Protect `main`: require the `CI` checks and one approving review.
3. Open an issue, add the `agent` label, watch the PR arrive.
