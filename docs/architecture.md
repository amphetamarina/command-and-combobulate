# Architecture

Command & Clanker is split so the backend ingests agent activity and owns the terminals,
and the frontend only draws. The map is **event-driven**: agents report their
tool calls to the server, which turns them into islands and robots. (The repo
is still named `Command & Clanker`.)

```
   Agent (Claude Code, opencode) running in an Command & Clanker terminal
            |  adapter posts tool calls / lifecycle events
            v
   Node server (backend)
     - POST /ingest: normalize agent events -> agents + folder islands
     - world builder: terminal islands + folder islands (no buildings)
     - TerminalManager: real PTYs via node-pty; injects CLANKER_* into the shell
            |
   WebSocket (agent snapshots + world deltas)  +  terminal I/O
            v
   Browser (Vite + Phaser 3)
     - isometric scene: terminal & folder islands, robot NPCs, cables
     - sidebar: logo, terminal tabs, docked terminal
     - camera / input
```

The backend runs under Node 22 with `--experimental-strip-types` (so it
executes the `.ts` sources directly); the test suite runs under the Bun test
runner. Shared modules avoid runtime-specific APIs so they work in both.

## How an agent reaches the map

When you build a terminal, `TerminalManager` spawns the shell with
`CLANKER_SESSION` (the terminal island id), `CLANKER_INGEST` (the ingest URL), and
`CLANKER_TOKEN` in its environment. An agent launched in that shell runs an Command & Clanker
adapter (see `integrations/`) that POSTs each tool call to `/ingest`,
authorized by the token and tagged with the session via the `X-Clanker-Session`
header. The server never scrapes `/proc`; it only knows what agents report.

## Backend (Node)

- **Ingest** (`server/index.ts`): `POST /ingest` normalizes a Claude Code hook
  payload into agent/world state. `SessionStart`/`SessionEnd` add and drop an
  agent per terminal; `SubagentStart`/`SubagentStop` add and drop child
  robots; `PostToolUse` with a `tool_input.file_path` points the agent's robot
  at that file's folder (read vs write) and registers the folder island. The
  endpoint acks immediately — Claude's HTTP hooks are synchronous and must not
  block the agent.
- **World builder** (`server/world-builder.ts`): a pure function of the live
  terminals and the folders agents are touching (no I/O during build). Each
  terminal and each work folder becomes a square island, placed on a meta-grid
  via a fixed shell slot-mapping so the layout stays square and gap-free. A
  `PlacementCache` keeps positions stable and reclaims slots when a terminal
  closes or a folder goes idle.
- **TerminalManager** (`server/terminals.ts`): spawns a real PTY per session
  with `node-pty`, injects the `CLANKER_*` env, buffers recent output, and bridges
  it to WebSocket clients. Because it is a true PTY it has a real window size
  and can be resized live, so full-screen TUIs (Claude Code, opencode) reflow
  to the terminal's actual width.

### HTTP / WebSocket surface (`server/index.ts`)

- `POST /ingest` — agent events (token in `Authorization`, terminal id in
  `X-Clanker-Session`). Acks instantly.
- `GET /world` — one-shot world snapshot (the island regions).
- `POST /term/new` (optional `{cols, rows}`), `POST /term/kill`, `WS /term?id=`
  — terminal lifecycle and I/O. Over the WS the client sends `{i: input}` for
  keystrokes and `{r: [cols, rows]}` to resize the PTY; the server sends raw
  shell output back.
- `WS /live` — pushes `agents` (the current robots, with their activity) and
  `world-delta` (the current islands) on each tick and when state changes.

## Frontend (Phaser 3 + Vite)

- **CityScene** (`src/scene.ts`) owns the isometric scene and consumes the
  WebSocket. `iso.ts` is the projection; `ground.ts` draws the islands
  (beveled rose panels with a grid), the animated terminal at a terminal
  island's centre, and the cables; `npc.ts` picks each robot from the agent's
  tool and homes it inside its terminal island; `sidebar.ts` is the HUD;
  `terminals.ts` drives the docked xterm.js panes and keeps the PTY sized to
  the sidebar.
- A robot is created per `agents` entry, homed on its terminal island
  (subagents render smaller). On a new `activity` it walks to that folder
  island, plays a read/write beat, and returns; cables from a terminal to its
  active folders are redrawn from the live `agents` stream.

## Determinism

Island layout is deterministic: positions come from the `PlacementCache` slot
assignment (not randomness), and work-island tint is `seedrandom(folder_path)`
while terminal islands share one tint. The cache is persisted to
`.clanker-cache.json` (`server/persistence.ts`), so islands stay put across
restarts.

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

type AgentSnapshot = {
  id: string;              // "t1" for the agent, "t1:sub:<id>" for a subagent
  terminal: string | null; // the terminal island it lives on
  kind: "agent" | "subagent";
  parent: string | null;
  tool: string;            // robot art source: "claude" | "opencode" | ...
  label: string;
  activity: { path: string; dir: string; direction: "read" | "write" } | null;
};
```

## Not yet decided / deferred

- **opencode adapter**: the same `/ingest` contract, fed by an opencode plugin
  (`tool.execute.before/after` + `event`). Claude Code is wired first.
- **Installer**: an `clanker install` that registers the adapter and templates the
  ingest URL/port, plus marketplace/npm distribution.
- **Action vocabulary**: richer beats for bash/search/spawn and per-tool
  animations beyond read/write.
