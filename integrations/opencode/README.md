# AIso adapter for opencode

This plugin streams opencode's tool calls to a running AIso server
(`POST /ingest`) so the agent's reads, writes, and commands animate on its
terminal island — the opencode counterpart of the Claude Code adapter.

opencode loads plugins from its plugin directory rather than a CLI flag. The
AIso terminal injects `AISO_OPENCODE` (the absolute path to `aiso.js`), so wire
it up once:

```sh
# inside an AIso terminal
mkdir -p ~/.config/opencode/plugin
ln -sf "$AISO_OPENCODE" ~/.config/opencode/plugin/aiso.js
```

Then run `opencode` inside any AIso terminal and its activity shows up on the
map. (Alternatively, add the path to `opencode.json`'s `"plugin"` array.)

The plugin reads `AISO_INGEST` / `AISO_TOKEN` / `AISO_SESSION` from the terminal
environment, posts the same payload shape the server already understands, and
tags it with `X-Aiso-Tool: opencode` so the robot uses the opencode art. It is
best-effort and never blocks the agent.
