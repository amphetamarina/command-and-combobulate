# Architecture

isotop is split so the backend is the only thing that touches the OS and
the frontend is the only thing that draws. Each can be replaced
independently (e.g. swap Phaser for Pixi without rewriting the samplers).

```
   Filesystem & /proc            (the real machine)
            |  read-only
            v
   Bun server (backend)
     - scanner: hashes running binaries
     - ProcSampler: per-process CPU and memory from /proc
     - FileActivitySampler: which file/folder a process is reading or writing
     - world builder: deterministic regions + buildings
     - TerminalManager: real PTY shells
            |
   HTTP (snapshot)  +  WebSocket (live world, processes, terminal I/O)
            v
   Browser (Vite + Phaser 3)
     - isometric scene: ground, walls, buildings, mech NPCs
     - sidebar: minimap, process inspector, terminal windows
     - camera / input
```

## Backend (Bun)

- **Scanner** (`server/scanner.ts`): SHA-256s each running binary into a
  `ManifestEntry`. Input to the world build.
- **World builder** (`server/world-builder.ts`): a pure function of the
  manifest (no I/O during build). Groups binaries by parent directory
  into regions, and places regions and the buildings within them on
  square grids via a fixed shell slot-mapping, so the map stays square.
  A `PlacementCache` keeps positions stable as binaries and directories
  appear, and reclaims slots when work regions expire. Work directories
  (folders a process is touching but with no binary) become building-less
  regions.
- **ProcSampler** (`server/proc.ts`): reads `/proc/<pid>` for exe, comm,
  RSS, and CPU jiffies; reports CPU as a share of one core between ticks
  and memory as a fraction of total RAM.
- **FileActivitySampler** (`server/activity.ts`): diffs each open file's
  offset in `/proc/<pid>/fdinfo` between ticks to find the file a process
  is actively reading or writing. Falls back to the process's `cwd` when
  it does bursty I/O with no long-lived handle (editors, agents).
- **TerminalManager** (`server/terminals.ts`): spawns a real PTY per
  session via `script -qfc "exec $SHELL -i" /dev/null` (no native addon),
  buffers recent output, and bridges it to WebSocket clients.

### HTTP / WebSocket surface (`server/index.ts`)

- `GET /world` — one-shot world snapshot (regions + buildings).
- `GET /procs`, `POST /kill` — process snapshot, signal a pid.
- `POST /term/new`, `POST /term/kill`, `WS /term?id=` — terminal lifecycle
  and byte stream.
- `WS /live` — pushes `procs` (snapshots with CPU/mem/activity) every tick
  and `world-delta` (new buildings, current regions) when the world
  changes.

## Frontend (Phaser 3 + Vite)

- **CityScene** (`src/scene.ts`) owns the isometric scene and consumes the
  WebSocket. `iso.ts` is the projection; `ground.ts` paints the floor and
  desert via blitters; `walls.ts` rings the platform; `npc.ts` places the
  mechs; `sidebar.ts` is the HUD (minimap, inspector, build); `terminals.ts`
  drives the xterm.js windows.
- The static world layer is append-mostly: deltas add buildings and
  re-render regions without disturbing what is already placed.

## Determinism

The world builder's only randomness comes from `seedrandom`, seeded by a
documented input — never `Math.random()`:

- Building sprite + sub-tile offset: `seed(sha256(binary_contents))`
  (overridden by a name match for known tools).
- Region tint: `seed(directory_path)`.

## Data shapes

```ts
type BuildingDescriptor = {
  id: string;            // stable, e.g. "/usr/bin/grep"
  district: string;      // parent directory
  tile: { x: number; y: number };
  footprint: { w: number; h: number };
  spriteKey: string;     // building/<name>/<variant> or tool/<name>
  hashShort: string;
  size: number;
};

type Region = {
  path: string;
  kind: "bin" | "work";
  origin: { x: number; y: number };
  size: { w: number; h: number };
  tint: number;
};

type World = { buildings: BuildingDescriptor[]; regions: Region[] };

type ProcessSnapshot = {
  pid: number; exe: string; comm: string;
  cpu: number; mem: number;                 // 0..1
  activity: { path: string; dir: string; direction: "read" | "write" } | null;
};
```

## Not yet decided / deferred

- **Persistence**: the world layout and placement cache live in process
  memory, so a restart reshuffles positions. Caching to disk (keyed by
  package-manager state) is the obvious next step.
- **Pipes between processes**: `/proc/<pid>/fd` socket/pipe inodes could
  link producers and consumers, but detection is its own spike.
- **Packaging**: web-only via `bun run dev` today; a Tauri wrapper is a
  possible later path.
