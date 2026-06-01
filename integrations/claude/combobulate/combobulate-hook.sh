#!/usr/bin/env bash
# Command & Combobulate hook: forward this tool/lifecycle event to the map. The tool
# name is the first argument, so each agent's adapter tags itself (claude, codex).
# Only acts inside a Command & Combobulate terminal (COMBOBULATE_SESSION is injected
# there), and is fast and silent so it never blocks the agent — safe to install
# globally.
[ -z "$COMBOBULATE_SESSION" ] && exit 0
[ -z "$COMBOBULATE_INGEST" ] && exit 0
tool="${1:-claude}"
curl -s --max-time 1 -X POST "$COMBOBULATE_INGEST" \
  -H "content-type: application/json" \
  -H "authorization: Bearer ${COMBOBULATE_TOKEN}" \
  -H "x-combobulate-session: ${COMBOBULATE_SESSION}" \
  -H "x-combobulate-tool: ${tool}" \
  --data-binary @- >/dev/null 2>&1 || true
exit 0
