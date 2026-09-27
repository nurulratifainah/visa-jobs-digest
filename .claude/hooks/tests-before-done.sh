#!/usr/bin/env bash
# Stop: the agent may not finish while tests are red in a package it touched.
# Runs only packages with uncommitted changes, so it stays fast.
set -uo pipefail
input=$(cat)
# Already blocked once this turn — let it stop and report rather than loop.
[[ $(node -e 'console.log(JSON.parse(process.argv[1]).stop_hook_active===true)' "$input") == "true" ]] && exit 0

root="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
cd "$root"
failed=0
for pkg in services/api services/ingester; do
  git status --porcelain -- "$pkg" "db" | grep -q . || continue
  [[ -d "$pkg/node_modules" ]] || continue
  if ! out=$(cd "$pkg" && npm test --silent 2>&1); then
    echo "Tests failing in $pkg — fix them (or explain why) before finishing:" >&2
    echo "$out" | tail -40 >&2
    failed=1
  fi
done
[[ $failed -eq 0 ]] || exit 2
