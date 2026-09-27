#!/usr/bin/env bash
# PostToolUse(Edit|Write): typecheck the package containing the edited file.
# Exit 2 feeds the compiler errors straight back to the agent so it fixes them
# in the same turn instead of discovering them in CI.
set -uo pipefail
file=$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.tool_input?.file_path??"")})')
[[ "$file" =~ \.(ts|tsx)$ ]] || exit 0

dir=$(dirname "$file")
root="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
while [[ "$dir" != "$root" && "$dir" != "/" && ! -f "$dir/tsconfig.json" ]]; do dir=$(dirname "$dir"); done
[[ -f "$dir/tsconfig.json" && -d "$dir/node_modules" ]] || exit 0

if ! out=$(cd "$dir" && npx --no-install tsc --noEmit 2>&1); then
  echo "Typecheck failed in ${dir#$root/}:" >&2
  echo "$out" | head -30 >&2
  exit 2
fi
