# AIso

https://github.com/user-attachments/assets/4b686165-1887-4f58-a574-95c35fa02fb7

`top`, but isometric — a live pixel-art map of what your AI agents are doing.
Build a terminal inside AIso and run an agent in it; every file it reads or
writes, every command it runs, and every subagent it spawns appears on the map
in real time. (The repository and package are still named `isotop`.)

## Quick start

```sh
mise install   # bun + node, pinned in mise.toml
bun install    # installs deps and compiles node-pty's native PTY
bun run dev    # Node backend + Vite frontend on :5173
```

Open <http://localhost:5173>, click **+ Terminal**, and in that terminal start
your agent with the AIso plugin:

```sh
claude --plugin-dir $AISO_PATH
```

`AISO_PATH` is injected into every AIso terminal, so that is the whole setup —
as the agent works, robots, folder islands, and file icons appear on the map.

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
- **Left sidebar** — the AIso logo, **+ Terminal**, tabs for open terminals, and
  the active terminal docked inline: a real `node-pty` shell that resizes with
  the panel, so full-screen TUIs render correctly.

## How it works

Agents report their tool calls to the backend at `POST /ingest` through an
adapter — a Claude Code plugin in [`integrations/`](integrations/). The AIso
terminal injects the ingest URL, a token, and the terminal-island id into the
shell, so events land on the right island. The backend turns them into islands
and robots and streams the world to a Vite + Phaser 3 frontend over WebSocket.
There is no `/proc` scraping; AIso shows only what agents report. See
[`docs/architecture.md`](docs/architecture.md).

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
