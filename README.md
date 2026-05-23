# isotop

`top`, but isometric. A live pixel-art rendering of your Unix machine:
every running binary is a building, grouped into a neighbourhood for the
directory it lives in, and every process is a mech standing by it — on a
walled station floating in the desert.

## Quick start

```sh
mise install   # installs bun
bun install
bun run dev
```

Open <http://localhost:5173>. The first load scans `/proc`, hashes the
running binaries, then streams live updates over a WebSocket.

## What you see

- **Buildings = binaries.** One per unique running executable; its shape
  and colour are derived from the SHA-256 of its contents, so it looks
  the same every time. Common tools (node, bun, claude, …) get dedicated
  art.
- **Regions = directories.** Buildings group into directory-tinted,
  labelled zones laid out on a square grid; new zones appear as new
  directories show up.
- **Mechs = processes.** One per PID, wandering by its building, labelled
  with its name and live CPU/memory bars. When a process actively reads
  or writes a folder, its mech walks there and the folder appears as a
  temporary work zone that fades when it goes idle.
- **The station.** A textured floor — metal pads under buildings, plain
  streets, tinted folder zones — walled at its perimeter and ringed by an
  irregular desert.
- **Sidebar (C&C-style).** A minimap (click to jump the camera), a
  process inspector with a KILL button when you select a mech, and a
  BUILD button.
- **Terminals.** Build a terminal and a real PTY shell opens in a
  draggable xterm.js window. Multiple sessions are listed in the sidebar
  and reconnect after a page reload.

## Controls

Pan: drag · Zoom: wheel · Select a mech: click · Jump the camera: click
the minimap · Hover a building or mech for details.

## Architecture

A Bun backend reads `/proc`, hashes binaries, builds a deterministic
world, and streams the world, process snapshots, and terminal I/O over
WebSocket. A Vite + Phaser 3 frontend renders the isometric scene. See
[`docs/architecture.md`](docs/architecture.md).

```
server/   Bun backend: /proc + CPU/mem + file-activity sampling,
          world builder, PTY terminals, HTTP + WebSocket
shared/   types shared by server and client
src/      Vite + Phaser 3 frontend: scene, ground, walls, npcs,
          sidebar/minimap, terminals
assets/   vendored sprite pack
docs/     vision, architecture, original v0 spec
```

## Scripts

```sh
bun run dev         # backend + frontend on :5173
bun run typecheck   # tsc --noEmit
bun test            # test runner
bun run build       # production build into dist/
```

## Not yet

- Mechs slide rather than walk (the pack ships 8-direction walk frames).
- The world layout lives in memory, so restarting the server reshuffles
  positions on the next load.
