# isotop

`top`, but isometric. An isometric 2D rendering of your live Unix
environment.

This repository contains the **v0 prototype**: a deterministic, snapshot
view of the binaries that are running on your machine right now,
rendered as isometric prisms on a tile floor.

## Quick start

```sh
mise install     # installs bun
bun install
bun run dev
```

Then open <http://localhost:5173>.

The first page load triggers a scan of `/proc` and a SHA-256 of each
unique exe found there. Expect a few seconds while the city is built.

## What you see

- Each prism is one **tool** (binary): something that has at least one
  process currently using it as its executable image.
- The prism's **shape and colour** are deterministically derived from
  the SHA-256 of the binary's contents. Same binary on a different
  machine produces the same building.
- Tiles are placed in a sorted grid so the same set of binaries
  always lays out the same way.
- Hovering a prism shows the binary's full path, the first 8 hex chars
  of its hash, and its size on disk.

## Controls

- **Pan**: click and drag.
- **Zoom**: mouse wheel.

## What v0 deliberately is not

- No NPCs and no live process visualisation. /proc is read once at
  page load, only to discover which binaries to draw. Processes
  themselves are reserved for a later milestone.
- No live refresh. Reload the page to rescan.
- No real art or sprites - solid-colour iso prisms only. The point of
  v0 is to validate that the deterministic city looks like something
  worth living in before investing in art.
- No persistence. The manifest is computed fresh on each `/world`
  request.
- No directories outside what `/proc` discovers.

See `docs/v0-spec.md` for the full scope statement and acceptance
criteria.

## Project layout

```
docs/        - vision, architecture sketch, v0 spec
server/      - Bun backend: /proc reader, file hasher, world builder, HTTP
shared/      - types shared between server and client
src/         - Vite + Phaser 3 frontend
scripts/     - dev orchestrator (spawns server + vite)
mise.toml    - pins bun
```

## Scripts

```sh
bun run dev         # backend + frontend on localhost:5173 (single port via vite proxy)
bun run typecheck   # tsc --noEmit
bun test            # bun's built-in test runner
bun run build       # vite production build into dist/
```

## Read next

- [`docs/idea.md`](docs/idea.md) - the broader vision
- [`docs/architecture.md`](docs/architecture.md) - architecture sketch
- [`docs/v0-spec.md`](docs/v0-spec.md) - what v0 is and is not
