# isotop

`top`, but isometric. A live, isometric pixel-art rendering of your
Unix environment: every running binary is a building, grouped into a
neighbourhood for the directory it lives in, and every running process
is a mech NPC standing on the street next to its building.

## Quick start

```sh
mise install     # installs bun
bun install
bun run dev
```

Then open <http://localhost:5173>.

The first page load triggers a scan of `/proc` and a SHA-256 of each
unique exe found there (a few seconds). After that, the page opens a
WebSocket to the Bun API on port 3001 and live updates stream in:
NPCs appear and disappear as processes spawn and exit, new buildings
appear when previously-unseen executables start running.

## What you see

- **Buildings = tools.** Each pixel-art building is one binary that
  has at least one running process using it as its executable image.
  The silhouette and colour variant are deterministically derived
  from the SHA-256 of the binary's contents, so the same binary on
  the same machine always looks the same.
- **Regions = directories.** Buildings are grouped by the directory
  their binary lives in (`/usr/bin`, `/usr/local/bin`,
  `~/.vscode-server/bin/<hash>`, ...). Each directory is a tinted
  zone on the ground labelled with its path. The tint is seeded by
  the directory path, so a folder keeps its colour. Regions are laid
  out on a square meta-grid and each region's buildings fill a square
  cluster, so the whole map stays roughly square no matter how many
  binaries are running. A new zone appears the moment a process from
  a never-before-seen directory starts.
- **Streets between buildings.** Tiles are placed on a sparse grid
  so every building has walkable street tiles around it, with wider
  gutters between regions.
- **NPCs = processes.** One small mech per PID, standing on a
  cardinal-neighbour street tile of its building. Mech colour is a
  deterministic function of the PID. NPCs appear when a process
  spawns and disappear within ~2s of it exiting.
- **Labels and usage bars.** Each mech carries its process name and
  two always-on bars: CPU (green/amber/red, full at one saturated
  core) and memory (blue, full at 20% of total RAM). The bars update
  every tick from live `/proc` samples.
- **Mechs work on folders.** When a process is actively reading or
  writing a file (its file offset advances between samples), the
  touched directory appears as a building-less work region and the
  mech walks over to it, shows a read/write badge, works briefly,
  and walks back. Idle held-open files do not count. Work regions are
  drawn distinctly from binary neighbourhoods (fainter fill, an
  outlined perimeter, an italic teal label) and fade away once the
  folder has seen no activity for ~15s.
- **Hover for details.** Hovering a building shows its full path,
  hash prefix, and size on disk. Hovering an NPC shows its PID,
  comm name, live CPU and memory, and exe.

## Controls

- **Pan**: click and drag.
- **Zoom**: mouse wheel.

## Status

- **v0** (shipped): static city of buildings keyed by SHA-256.
- **v1** (shipped): live NPC layer.
- **v1.1** (shipped): custom Tiberian-Sun-style sprite pack
  (`assets/isotop-assets/`), darker solid ground, organic sub-tile
  offsets so the layout looks less rigid, NPCs wander between
  street tiles via Phaser tweens (no walk animation yet), world
  auto-updates when a new exe starts running, WebSocket push
  replaces HTTP polling.
- **v1.2** (shipped): buildings are grouped into folder regions on a
  square map. Each directory is a directory-tinted, labelled zone;
  regions and the buildings within them are placed on square grids
  via a shell slot-mapping, with an adaptive grid stride that keeps
  neighbourhoods packed close together.
- **v1.3** (shipped): per-process CPU and memory sampled from `/proc`,
  shown as always-on name labels and RTS-style usage bars above each
  mech.
- **v1.4** (shipped): active file I/O detected from
  `/proc/<pid>/fdinfo` offset deltas; touched directories become work
  regions and mechs walk to the folder they are reading or writing.

## What isotop deliberately is not yet

- NPCs slide rather than walk. The pack ships walk-cycle frames
  in 8 directions; v2 will use them.
- The WebSocket connects directly to the Bun API port (3001) in
  dev because Vite's WS proxy is unreliable here. In a deployed
  single-port setup it would proxy normally.
- No persistence: the placement cache lives in process memory, so
  restarting the server reshuffles building positions on next
  page load.
- The pack's ground tileset is unused; the procedural dark
  diamond floor in `src/ground.ts` pairs better with the cool
  sprite palette than the pack's warmer terrain tiles would.

See `docs/v0-spec.md` for the original scope statement; `docs/idea.md`
and `docs/architecture.md` for the broader design.

## Project layout

```
assets/      - vendored CC0 sprite pack (acdrnx)
docs/        - vision, architecture sketch, v0 spec
server/      - Bun backend: /proc reader, hasher, world builder, /world + /procs
shared/      - types shared between server and client
src/         - Vite + Phaser 3 frontend (scene, npcs, iso projection)
scripts/     - dev orchestrator (spawns server + vite)
mise.toml    - pins bun
```

## Scripts

```sh
bun run dev         # backend + frontend on localhost:5173
bun run typecheck   # tsc --noEmit
bun test            # bun's built-in test runner
bun run build       # vite production build into dist/
```

## Read next

- [`docs/idea.md`](docs/idea.md) - the broader vision
- [`docs/architecture.md`](docs/architecture.md) - architecture sketch
- [`docs/v0-spec.md`](docs/v0-spec.md) - what v0 was scoped to
- [`assets/sci-fi-acdrnx/LICENSE.md`](assets/sci-fi-acdrnx/LICENSE.md) - asset pack provenance
