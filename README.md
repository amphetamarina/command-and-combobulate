# AIso

`top`, but isometric — a live pixel-art map of what your terminals are
running. Build a terminal inside AIso and it becomes an EXAPUNKS-style host
island; every process it spawns is a robot living on that island, and the
folders its agents touch become islands wired to it by cables. (The
repository and package are still named `isotop`.)

## Quick start

```sh
mise install   # bun + node, pinned in mise.toml
bun install    # installs deps and compiles node-pty's native PTY
bun run dev    # Node backend + Vite frontend
```

Open <http://localhost:5173>. The first load scans `/proc`, hashes the
running binaries, then streams live updates over a WebSocket.

> The backend runs under **Node** (for `node-pty`); the test suite runs
> under **Bun**. `bun install` compiles `node-pty`, which needs a C/C++
> toolchain (`python3`, `make`, `g++`) — present on most dev machines.

## What you see

- **Terminal islands.** Each terminal you build is a flat rose panel with a
  faint isometric grid and beveled edges, labelled with the shell's working
  directory. Its processes live here.
- **Folder islands.** Each folder an agent touches becomes its own island,
  wired to the terminal whose process is working there by a cable.
- **Robots = processes.** One per process descending from a terminal.
  `claude`, `codex`, and `opencode` walk their own robot; everything else
  gets a generic chassis. Robots wander their terminal island with live
  CPU/memory bars, and when a process reads or writes a folder its robot
  walks to that folder's island and back.
- **Left sidebar.** The AIso logo, a "+ Terminal" button, a tab per open
  terminal, and the active terminal docked inline — a real shell over
  `node-pty`, sized to the sidebar and reflowing live, so Claude Code,
  opencode, and other full-screen TUIs render correctly.

AIso shows only the processes that descend from terminals built inside it,
not your whole machine.

## Controls

Pan: drag · Zoom: wheel · Hover a building or robot for details.

## Architecture

A Node backend reads `/proc`, attributes each process to the in-app
terminal it descends from, builds the island world (terminals + the
folders their agents touch), and streams the world, process snapshots, and
terminal I/O over HTTP + WebSocket (the `ws` library). A Vite + Phaser 3
frontend renders the isometric scene; terminals run on `node-pty`. See
[`docs/architecture.md`](docs/architecture.md).

```
server/   Node backend: /proc + CPU/mem + file-activity sampling,
          world builder, node-pty terminals, HTTP + WebSocket (ws)
shared/   types shared by server and client
src/      Vite + Phaser 3 frontend: scene, islands, robots, sidebar,
          docked terminals
assets/   vendored sprite pack + logo
docs/     vision, architecture, original v0 spec
```

## Scripts

```sh
bun run dev         # Node backend + Vite frontend on :5173
bun run dev:server  # backend only (node --watch)
bun run typecheck   # tsc --noEmit
bun test            # test runner (Bun)
bun run build       # production build into dist/
```

## Not yet

- The claude robot art is a top-down sprite, out of style with the
  3/4-view codex/opencode robots; it needs regenerating.
- Distinguishing a main agent from its subagents visually (size/labels).
