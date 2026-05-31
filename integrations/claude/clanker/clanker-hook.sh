#!/usr/bin/env bash
# Command & Clanker hook: forward this tool/lifecycle event to the map. The tool
# name is the first argument, so each agent's adapter tags itself (claude, codex).
# Only acts inside a Command & Clanker terminal (CLANKER_SESSION is injected
# there), and is fast and silent so it never blocks the agent — safe to install
# globally.
[ -z "$CLANKER_SESSION" ] && exit 0
[ -z "$CLANKER_INGEST" ] && exit 0
tool="${1:-claude}"
curl -s --max-time 1 -X POST "$CLANKER_INGEST" \
  -H "content-type: application/json" \
  -H "authorization: Bearer ${CLANKER_TOKEN}" \
  -H "x-clanker-session: ${CLANKER_SESSION}" \
  -H "x-clanker-tool: ${tool}" \
  --data-binary @- >/dev/null 2>&1 || true
exit 0
