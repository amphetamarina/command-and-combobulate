# Command & Clanker adapter for opencode

This plugin streams opencode's tool calls to a running Command & Clanker server
(`POST /ingest`) so the agent's reads, writes, and commands animate on its
terminal island — the opencode counterpart of the Claude Code adapter.

## Install

From the repo, run `bun run setup` once: it symlinks this plugin into
`~/.config/opencode/plugin/clanker.js`, so any `opencode` launched inside an Command & Clanker
terminal reports automatically.

Manual alternative (the Command & Clanker terminal injects `CLANKER_OPENCODE`, the path to
`clanker.js`):

```sh
mkdir -p ~/.config/opencode/plugin
ln -sf "$CLANKER_OPENCODE" ~/.config/opencode/plugin/clanker.js
```

For sharing, publish this directory as `@clanker/opencode-plugin` and list it in
`opencode.json`'s `"plugin"` array.

The plugin reads `CLANKER_INGEST` / `CLANKER_TOKEN` / `CLANKER_SESSION` from the terminal
environment, posts the same payload shape the server already understands, and
tags it with `X-Clanker-Tool: opencode` so the robot uses the opencode art. It is
best-effort and never blocks the agent.
