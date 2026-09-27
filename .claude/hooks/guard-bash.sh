#!/usr/bin/env bash
# PreToolUse(Bash): hard stops that no prompt can talk the agent past.
set -uo pipefail
cmd=$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{console.log(JSON.parse(s).tool_input?.command??"")})')
deny() { echo "Blocked by .claude/hooks/guard-bash.sh: $1" >&2; exit 2; }

[[ "$cmd" =~ git[[:space:]]+push.*(--force|-f([[:space:]]|$)) ]] && deny "force push"
[[ "$cmd" =~ git[[:space:]]+push.*[[:space:]](origin[[:space:]]+)?main([[:space:]]|$) ]] && deny "push to main — open a PR"
[[ "$cmd" =~ (^|[[:space:]])(cat|less|head|tail)[[:space:]].*\.env([[:space:]]|$) ]] && deny "reading .env"
[[ "$cmd" =~ docker[[:space:]]+compose[[:space:]]+down.*-v ]] && deny "deleting volumes (db + model cache)"
exit 0
