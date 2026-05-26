# Architecture

isotop is split so the backend is the only thing that touches the OS and
the frontend is the only thing that draws. Each can be replaced
independently (e.g. swap Phaser for Pixi without rewriting the samplers).

```
   Filesystem & /proc            (the real machine)
            |  read-only
            v
   Node server (backend)
     - ProcSampler: per-process CPU/memory, plus the terminal each
       process descends from
     - FileActivitySampler: which file/folder a process is reading or writing
     - world builder: terminal islands + folder islands (no buildings)
     - TerminalManager: real PTYs via node-pty
            |
   HTTP (snapshot)  +  WebSocket (live world, processes, terminal I/O)
            v
   Browser (Vite + Phaser 3)
     - isometric scene: terminal & folder islands, robot NPCs, cables
     - sidebar: logo, terminal tabs, docked terminal
     - camera / input
```

The backend runs under Node 22 with `--experimental-strip-types` (so it
executes the `.ts` sources directly); the test suite still runs under the
Bun test runner. Shared modules avoid runtime-specific APIs so they work
in both.

## Backend (Node)

- **World builder** (`server/world-builder.ts`): a pure function of the
  live terminals and the folders agents are touching (no I/O during build).
  Each terminal and each work folder becomes a square island, placed on a
  meta-grid via a fixed shell slot-mapping so the layout stays square and
  gap-free. A `PlacementCache` keeps positions stable as islands appear and
  reclaims slots when a terminal closes or a folder goes idle.
- **ProcSampler** (`server/proc.ts`): reads `/proc/<pid>` for exe, comm,
  RSS, ppid, and CPU jiffies; reports CPU as a share of one core between
  ticks and memory as a fraction of total RAM. It also tags each process
  with the in-app terminal it descends from (BFS over the ppid tree from
  each terminal's pid) and drops processes that descend from none.
- **FileActivitySampler** (`server/activity.ts`): diffs each open file's
  offset in `/proc/<pid>/fdinfo` between ticks to find the file a process
  is actively reading or writing. Falls back to the process's `cwd` when
  it does bursty I/O with no long-lived handle (editors, agents).
- **TerminalManager** (`server/terminals.ts`): spawns a real PTY per
  session with `node-pty`, buffers recent output, and bridges it to
  WebSocket clients. Because it is a true PTY it has a real window size and
  can be resized live, so full-screen TUIs (Claude Code, opencode) reflow
  to the terminal's actual width.

### HTTP / WebSocket surface (`server/index.ts`)

- `GET /world` — one-shot world snapshot (the island regions).
- `GET /procs`, `POST /kill` — process snapshot, signal a pid.
- `POST /term/new` (optional `{cols, rows}`), `POST /term/kill`,
  `WS /term?id=` — terminal lifecycle and I/O. Over the WS the client sends
  `{i: input}` for keystrokes and `{r: [cols, rows]}` to resize the PTY;
  the server sends raw shell output back.
- `WS /live` — pushes `procs` (snapshots with CPU/mem/activity/terminal)
  every tick and `world-delta` (the current islands) when a terminal or
  work folder appears or disappears.

## Frontend (Phaser 3 + Vite)

- **CityScene** (`src/scene.ts`) owns the isometric scene and consumes the
  WebSocket. `iso.ts` is the projection; `ground.ts` draws the folder
  islands (beveled rose panels with a grid) and the cables between them;
  `npc.ts` picks each robot from its process exe and homes it inside its
  terminal island; `sidebar.ts` is the HUD (logo, terminal tabs);
  `terminals.ts` drives the docked xterm.js panes and keeps the PTY sized to
  the sidebar.
- Each process robot lives on its terminal island and walks to a folder
  island when its process reads or writes there; cables from a terminal to
  the folders it is touching are redrawn from the live process stream.

## Determinism

The world builder's only randomness comes from `seedrandom`, seeded by a
documented input — never `Math.random()`:

- Work-island tint: `seed(folder_path)`. Terminal islands share one tint.

Island positions come from the `PlacementCache` slot assignment, not
randomness, so they are stable across rebuilds.

## Data shapes

```ts
type Region = {
  path: string;            // a folder path, or a terminal id like "t1"
  kind: "terminal" | "work";
  label: string;           // shell cwd for terminals, folder path for work
  origin: { x: number; y: number };
  size: { w: number; h: number };
  tint: number;
};

type World = { buildings: never[]; regions: Region[] };

type ProcessSnapshot = {
  pid: number; ppid: number;
  terminal: string | null;  // id of the terminal it descends from
  exe: string; comm: string;
  cpu: number; mem: number;                 // 0..1
  activity: { path: string; dir: string; direction: "read" | "write" } | null;
};
```

The placement cache is persisted to `.isotop-cache.json`
(`server/persistence.ts`), so positions stay stable across restarts.

## Not yet decided / deferred

- **Main agent vs subagents**: every descendant is currently an equal
  robot; distinguishing a top-level agent from its spawned subagents
  (size, labels) is a visual follow-up.
- **Pipes between processes**: `/proc/<pid>/fd` socket/pipe inodes could
  link producers and consumers, but detection is its own spike.
- **Packaging**: web-only via `bun run dev` today; a Tauri wrapper is a
  possible later path.
