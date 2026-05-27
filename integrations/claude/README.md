# Command & Clanker adapter for Claude Code

This plugin streams every Claude Code tool call and subagent event to a
running Command & Clanker server (`POST /ingest`), so the agent's activity is rendered on
the map. It is the event source that replaces `/proc` scraping.

## How it ties to a terminal island

When you build a terminal inside Command & Clanker, the server injects three env vars into
that shell:

- `CLANKER_SESSION` — the terminal island id (e.g. `t1`)
- `CLANKER_INGEST` — the ingest URL (default `http://127.0.0.1:3001/ingest`)
- `CLANKER_TOKEN` — a per-run token authorizing the endpoint

The hooks send `CLANKER_SESSION` and `CLANKER_TOKEN` as headers, so the server knows
which island the events belong to. Run Claude Code **inside an Command & Clanker terminal**
and its reads/writes/subagents animate on that terminal's island.

## Install

From the repo, run `bun run setup` once: it merges these hooks (as an absolute
command path) into `~/.claude/settings.json`, so any `claude` launched inside an
Command & Clanker terminal reports automatically. The hook is gated on `CLANKER_SESSION` and
runs with `curl --max-time 1`, so it is silent and non-blocking everywhere else.

No-install alternative: the Command & Clanker terminal injects `CLANKER_PATH` (this plugin's
directory), so you can run `claude --plugin-dir $CLANKER_PATH` instead.

To share it as a plugin, this directory's parent carries a
`.claude-plugin/marketplace.json`; add it with
`/plugin marketplace add <repo>/integrations/claude` and install `clanker`.

## Events sent

`SessionStart`, `SessionEnd`, `PostToolUse`, `SubagentStart`, `SubagentStop`.
The server reads `tool_name` + `tool_input.file_path` to decide which folder a
robot walks to (read vs write), and uses `agent_id` to distinguish subagents.

> Note: the ingest URL is currently hardcoded to port 3001 in `hooks.json`. If
> you run the Command & Clanker server on another port, edit the `url` fields (the installer
> will template this later).
