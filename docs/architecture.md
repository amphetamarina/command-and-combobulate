# Architecture

Command & Clanker is two pieces: a Node **backend** that ingests agent activity and
owns the real terminals, and an **OpenRA mod** that renders that activity inside the
OpenRA engine. The world is event-driven — agents report their tool calls; nothing
scrapes `/proc`.

```
   Agent (Claude Code, opencode, …) in a Command & Clanker terminal
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
  tool: string;            // unit per tool: "claude" | "opencode" | ...
  label: string;
  activity: { path: string; dir: string; direction: "read" | "write" | "run" } | null;
};
```

## Determinism

Folder and terminal positions are deterministic: the backend's `PlacementCache`
assigns stable slots (persisted to `.clanker-cache.json`), and the mod lays
folders out as a stable indented tree keyed by recycled rows, so the map does not
reshuffle as folders come and go.
