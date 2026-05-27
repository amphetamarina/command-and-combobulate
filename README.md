# Command & Clanker

https://github.com/user-attachments/assets/4b686165-1887-4f58-a574-95c35fa02fb7

`top`, but isometric — a live pixel-art map of what your AI agents are doing.
Build a terminal inside Command & Clanker and run an agent in it; every file it reads or
writes, every command it runs, and every subagent it spawns appears on the map
in real time. (The repository and package are still named `Command & Clanker`.)

## Quick start

```sh
mise install   # bun + node, pinned in mise.toml
bun install    # installs deps and compiles node-pty's native PTY
bun run dev    # Node backend + Vite frontend on :5173
```

Open <http://localhost:5173> and click **+ Terminal**. To make agents report to
the map, install the adapters once:

```sh
bun run setup   # wires the Claude Code + opencode adapters into your config
```

Then run an agent inside any Command & Clanker terminal and watch it work:

```sh
claude       # Claude Code
opencode     # opencode
```

The adapters only report from inside an Command & Clanker terminal (where `CLANKER_SESSION` is
injected), so they stay quiet everywhere else. No-install alternative for
Claude: `claude --plugin-dir $CLANKER_PATH`.

> The backend runs under **Node** (for `node-pty`); tests run under **Bun**.
> `bun install` compiles `node-pty`, which needs a C/C++ toolchain
> (`python3`, `make`, `g++`) — present on most dev machines.

## What you see

- **Terminal islands** — one per terminal you build, labelled with its shell's
  working directory; its agents live here.
- **Robots** — one per agent, plus a smaller one per subagent. A robot walks to
  the folder a tool touches and shows whether it is reading, writing, or
  running a command. Click one to see what it is doing now.
- **Folder islands** — each folder an agent touches, cabled to its terminal,
  with a file icon per file (stacking when there are many). Hover a file for its
  name and size; click it to read its contents.
- **Left sidebar** — the Command & Clanker logo, **+ Terminal**, tabs for open terminals, and
  the active terminal docked inline: a real `node-pty` shell that resizes with
  the panel, so full-screen TUIs render correctly.

## How it works

Agents report their tool calls to the backend at `POST /ingest` through an
adapter — a Claude Code plugin in [`integrations/`](integrations/). The Command & Clanker
terminal injects the ingest URL, a token, and the terminal-island id into the
shell, so events land on the right island. The backend turns them into islands
and robots and streams the world to a Vite + Phaser 3 frontend over WebSocket.
There is no `/proc` scraping; Command & Clanker shows only what agents report. See
[`docs/architecture.md`](docs/architecture.md).

The Claude adapter is a plugin under
[`integrations/claude/clanker`](integrations/claude/clanker) (with a marketplace
manifest), and the opencode adapter is a package under
[`integrations/opencode/clanker`](integrations/opencode/clanker)
(`@clanker/opencode-plugin`). `bun run setup` wires the local copies; to share
them, add the Claude marketplace (`/plugin marketplace add …/integrations/claude`)
or publish the opencode package and list it in `opencode.json`.

```
server/        Node backend: /ingest event sink, world builder,
               node-pty terminals, HTTP + WebSocket (ws)
shared/        types shared by server and client
src/           Vite + Phaser 3 frontend: scene, islands, robots, files
integrations/  agent adapters (Claude Code plugin; opencode next)
assets/        vendored sprite pack + logo
docs/          vision, architecture, v0 spec
```

## Controls

Pan: drag · Zoom: wheel · Hover an island, robot, or file for details · Click a
robot to see what it is doing, or a file to read it.

## Scripts

```sh
bun run dev         # Node backend + Vite frontend on :5173
bun run dev:server  # backend only (node --watch)
bun run typecheck   # tsc --noEmit
bun test            # test runner (Bun)
bun run build       # production build into dist/
```

## Inspired by

- [EXAPUNKS](https://www.zachtronics.com/exapunks/) — its hosts, files, and links
- [Factorio](https://www.factorio.com/) — the living-machine, watch-it-run feel
- [OpenRA](https://www.openra.net/) — open-source Command & Conquer, for the RTS sidebar and build flow

