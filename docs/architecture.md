# Architecture

Command & Clanker is two pieces: a Node **backend** that ingests agent activity and
owns the real terminals, and an **OpenRA mod** that renders that activity inside the
OpenRA engine. The world is event-driven — agents report their tool calls; nothing
scrapes `/proc`.

```
   Agent (Claude Code, Codex) in a Command & Clanker terminal
            |  adapter POSTs tool calls / lifecycle events
            v
   Node backend (server/)
     - POST /ingest: normalize agent events -> agents + folder regions
     - world builder: terminal + folder regions (a directory forest)
     - TerminalManager: real PTYs via node-pty; injects CLANKER_* into the shell;
       a headless xterm resolves each PTY into a screen grid
            |
   WebSocket: /live (agents + world deltas + files) and /termview (screen grids)
            v
   OpenRA mod (command-and-clanker/)
     - ClankerBridge (world trait): connect on a background thread, apply deltas
       on the game thread -> terminal buildings, folder walls, file buildings,
       agent units, fog
     - ClankerTerminalWidget: a live, interactive terminal panel
     - Start menu: "Start Clanking" boots straight into the canvas map
```

## How an agent reaches the map

Building a Terminal spawns a shell with `CLANKER_SESSION` (the terminal id),
`CLANKER_INGEST` (the ingest URL), and `CLANKER_TOKEN`. An agent launched there runs
a Command & Clanker adapter (see `integrations/`) that POSTs each tool call to
`/ingest`, authorized by the token and tagged with the session via
`X-Clanker-Session` (and the tool via `X-Clanker-Tool`).

## Filesystem → map

The map is not a mirror of the filesystem. Only the parts an agent actually
touches show up, and the layout is engineered for stability — files coming and
going never reshuffle the world.

### What becomes a region

Two things produce regions on the map:

- **Terminal islands** — one per live terminal, fixed footprint
  (`TERMINAL_SIZE`). Identified by the terminal id (`t1`, `t2`, …), not a
  filesystem path.
- **Folder islands ("work" regions)** — one per *touched* directory. A
  directory is touched when an agent reads or writes a file inside it
  (`PostToolUse` with a `file_path` → that file's parent dir) or runs a
  command from it (Bash → the shell's cwd). Untouched directories — including
  intermediate ones on the path — do not exist on the map.

Touched dirs are tracked in `workDirLastActive` (`server/index.ts`) and a
janitor sweep evicts ones idle past a TTL, which drops their regions from the
next world tick.

### Nesting by path prefix

`buildForest` in `server/world-builder.ts` arranges touched dirs into a
forest:

- Sort the touched dirs.
- For each dir, its parent is the **deepest other touched dir that is a path
  prefix of it** (matched with a trailing `/` so `/foo/bar` does not adopt
  `/foo/barn`).
- Dirs with no touched ancestor become roots.

So if an agent only touches `/a/b/c` and `/a/b/c/d/e`, only those two regions
exist and the second nests inside the first — `/a`, `/a/b`, and `/a/b/c/d`
are invisible. If the agent later touches `/a/b`, it becomes a new ancestor;
the old root re-parents under it on the next tick, and `PlacementCache`
releases the now-orphaned root slot.

### Where files live inside a folder

Each folder region carves its interior into two zones (see `placeNode` and
the `fileArea` field on `Region`):

- A top **file strip** of height `FILE_ROWS`, padded by `PAD`. This is the
  `fileArea` rectangle the client paints file icons into.
- A grid of child folder regions below the strip, laid out roughly square
  (`ceil(sqrt(children))` columns), separated by `GAP`. The parent's size
  expands to contain them.

Touched files are recorded by `recordFile` (`server/index.ts`) into
`filesByDir[dir]`, capped at `FILES_PER_DIR` with oldest-evicted-first. Each
entry carries `direction: "read" | "write"`, size, and a timestamp; the mod
renders them as fog-hidden civilian buildings inside the parent region's
`fileArea`. Files coming and going never resize the region — only the set of
touched *folders* does.

### Stability guarantees

Two layers of placement caching keep the map calm:

- `PlacementCache.region` assigns each root (terminal or top-level folder) a
  stable integer slot on a meta-grid (`squareCell` spirals outward). When a
  root disappears, its slot is recycled via `freeRegionSlots` so a new root
  fills the gap nearest the origin instead of pushing everything outward.
- Inside a folder, child order is `dirs.sort()` and the grid shape is a
  function of the child count, so adding a child only reshapes that subtree.
- The mod (`ClankerBridge`) lays files inside `fileArea` keyed by stable rows
  so an evicted file's neighbours do not slide.

Cache state is persisted to `.clanker-cache.json` (`server/persistence.ts`)
so slots survive a backend restart.

### Wire-level summary

A client gets the filesystem view in two streams:

- `world-delta` (and the `/world` snapshot) carries `Region[]`: terminal and
  folder rectangles with `origin`, `size`, `level`, and `fileArea`.
- `files` carries `{ dir, entries: FileEntry[] }[]`: per-folder file lists,
  with each entry's `direction` and `ts`. The client positions entries
  inside the matching region's `fileArea`.

Agents reference the filesystem through their `activity` field
(`{ path, dir, direction }`), which is how an agent unit knows which folder
region to drive to and which file to act on.

## Backend (Node)

Runs under Node 22 with `--experimental-strip-types` (executes `.ts` directly);
tests run under Bun.

- **Ingest** (`server/index.ts`): normalizes a hook payload into agent/world
  state. `SessionStart`/`SessionEnd` add and drop an agent per terminal;
  `SubagentStart`/`SubagentStop` add and drop child agents; `PostToolUse` with a
  `file_path` points the agent at that file's folder (read vs write), and Bash at
  the shell's cwd (run). Acks immediately — hooks are synchronous.
- **World builder** (`server/world-builder.ts`): a pure function of the live
  terminals and touched folders, producing terminal regions and a nested folder
  forest. A `PlacementCache` (`server/persistence.ts`, `.clanker-cache.json`)
  keeps positions stable across restarts.
- **TerminalManager** (`server/terminals.ts`): a real PTY per session via
  node-pty, with a headless `@xterm/headless` emulator that resolves the PTY's
  cursor moves into a stable screen grid for clients that cannot run a VT parser.

### HTTP / WebSocket surface

- `POST /ingest` — agent events (token in `Authorization`, ids in `X-Clanker-*`).
- `GET /world` — one-shot world snapshot.
- `POST /term/new`, `POST /term/kill` — terminal lifecycle.
- `WS /term?id=` — raw PTY byte stream (`{i}` input, `{r:[c,r]}` resize).
- `WS /termview?id=` — resolved screen-grid frames (`term-grid`), same input/resize.
- `POST /agent/freeze|unfreeze|interrupt|ask` — drive the agent's process.
- `WS /live` — `agents`, `world-delta`, and `files` on each tick and on change.

## OpenRA mod (command-and-clanker/)

Built on the OpenRA Mod SDK: `make` fetches the pinned engine (`mod.config`
`ENGINE_VERSION`) and builds `OpenRA.Mods.Clanker` against it.

- **ClankerBridge** (`Traits/ClankerBridge.cs`, on the World actor): runs the
  `/live` WebSocket on a background thread that only enqueues messages; all
  World/Actor/resource changes happen on the game thread via `AddFrameEndTask`.
  It turns regions into terminal buildings and folder walls (laid out as a stable
  nested compounds), files into fog-hidden civilian buildings, and agents into units that drive to
  the folder they are working in. It also consumes `/termview` and forwards
  keystrokes back to the PTY.
- **ClankerTerminalWidget** (`Widgets/`): paints the screen grid in a monospace
  font and routes keystrokes to the selected terminal — a live, interactive
  terminal inside the game.
- **Mod files** (`mods/clanker/`): rules, sequences, chrome, fluent, and the
  `clanker-canvas` sandbox map; reuses OpenRA's Red Alert art.

## Wire shapes

```ts
type Region = {
  path: string;            // a folder path, or a terminal id like "t1"
  kind: "terminal" | "work";
  label: string;
  origin: { x: number; y: number };
  size: { w: number; h: number };
  // folder regions also carry level / fileArea for tree layout
};

type AgentSnapshot = {
  id: string;              // "t1", or "t1:sub:<id>" for a subagent
  terminal: string | null;
  kind: "agent" | "subagent";
  parent: string | null;
  tool: string;            // unit per tool: "claude" | "codex"
  label: string;
  activity: { path: string; dir: string; direction: "read" | "write" | "run" } | null;
};
```

## Determinism

Folder and terminal positions are deterministic: the backend's `PlacementCache`
assigns stable slots (persisted to `.clanker-cache.json`), and the mod lays
folders out as a stable indented tree keyed by recycled rows, so the map does not
reshuffle as folders come and go.
