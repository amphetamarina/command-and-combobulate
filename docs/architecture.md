# Architecture sketch

This is a working sketch, not a final design. It exists to make the v0 spec
concrete and to flag the moving parts that will need decisions later.

## High-level shape

```
       +----------------------------+
       |   Filesystem & /proc       |   <-- the real machine
       +-------------+--------------+
                     |
                     | (read-only)
                     v
       +----------------------------+
       |   Bun server (backend)     |
       |                            |
       |   - Scanner: walks $PATH,  |
       |     hashes binaries        |
       |   - Watcher: polls /proc   |
       |     for processes & pipes  |
       |   - Seeded world builder   |
       +-------------+--------------+
                     |
       REST (static) | WebSocket (dynamic)
                     v
       +----------------------------+
       |   Browser (frontend)       |
       |                            |
       |   - Phaser 3 isometric     |
       |     renderer               |
       |   - World state store      |
       |   - Input / camera         |
       +----------------------------+
```

The split is on purpose: the backend is the only thing that touches the OS,
and the frontend is the only thing that draws. Each can be replaced
independently (e.g., swap Phaser for Pixi without rewriting the scanner).

## Component responsibilities

### Backend (Bun)

- **Scanner**: enumerates targeted directories (starting with `/usr/bin`),
  computes a stable content hash per file, returns a structured manifest.
  This is the input to the deterministic world build.
- **World builder**: takes the manifest plus a seed strategy (see below) and
  emits a world description: districts, buildings, positions, visual
  parameters. Pure function of its inputs. No I/O during build.
- **Live watcher**: polls `/proc` on an interval, diffs against last snapshot,
  pushes process and pipe events over a WebSocket.
- **HTTP/WS surface**: `GET /world` for the static description, `WS /live`
  for the dynamic stream. Versioned from day one.

### Frontend (Phaser 3 + Vite)

- **Scene: City** — owns the isometric tilemap and building sprites.
- **Renderer adapters** — translate world-builder output into Phaser
  GameObjects. Adapters are the only Phaser-aware code; the rest is plain TS.
- **Live overlay** — consumes WS events and spawns/despawns NPC sprites and
  cargo robots without touching the static layer.
- **Camera/input** — pan, zoom, click-to-inspect.

## Determinism strategy

A single utility, `seed(input: string) -> PRNG`, is the only source of
randomness in the world builder. Every visual decision pulls from a PRNG
seeded by a documented input:

- Building geometry: `seed(sha256(binary_contents))`
- District street layout: `seed(directory_absolute_path)`
- Player-home style: `seed(username + hostname)`

Forbidden: `Math.random()` anywhere in the world builder. Lint rule will
enforce this once we have CI.

## Data shapes (sketch, not final)

```ts
type BuildingDescriptor = {
  id: string;            // stable, e.g. "/usr/bin/grep"
  district: string;      // "/usr/bin"
  tile: { x: number; y: number };
  footprint: { w: number; h: number };
  heightTiers: number;
  palette: string;       // resolved from hash
  hashShort: string;     // first 8 hex chars, shown on hover
};

type LiveEvent =
  | { kind: "process_spawn"; pid: number; ppid: number; comm: string; cwd: string }
  | { kind: "process_exit"; pid: number }
  | { kind: "pipe_active"; producerPid: number; consumerPid: number; bytesPerSec: number }
  | { kind: "pipe_idle"; producerPid: number; consumerPid: number };
```

These will change. The point of writing them now is to make the v0 build
forced to commit to *some* shape so we can iterate against it.

## Decisions deferred

These are flagged here so they are not silently made during v0:

- **Tile pixel size and projection ratio** (affects every asset).
- **Asset pipeline**: hand-drawn sprites vs. generated geometry vs. mixed.
- **Pipe detection method**: parsing `/proc/*/fd` symlinks is the obvious
  path but has edge cases (anonymous pipes vs. named, FIFOs, sockets).
  Needs a spike of its own.
- **Persistence**: do we cache the static world description on disk to
  avoid rehashing every binary on startup? Probably yes, keyed by package
  manager state, but not in v0.
- **Packaging**: web-only via `bun --hot`, or Tauri wrapper for a real
  desktop app. Defer until aesthetic is validated.

## Why this shape

- The backend/frontend split makes the `/proc`-reading half of the system
  testable without a browser, and the rendering half mockable without a
  real machine.
- WebSocket for live state, REST for static state, because they have
  genuinely different lifecycles and mixing them on one channel makes both
  harder to reason about.
- Phaser is the renderer, not the architecture. If the aesthetic in v0
  disappoints, the backend survives a swap to Pixi or Godot's HTML export.
