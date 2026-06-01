# AGENTS.md

Orientation for AI coding agents working in this repository. Human contributors
should read `README.md` first; this file assumes that context and adds the
conventions an agent needs to make changes safely.

## What this repo is

Command & Clanker visualises an AI agent's tool calls as an
[OpenRA](https://www.openra.net) real-time strategy game. The agent's terminal
is a building, files are smaller buildings inside folder compounds, and every
read/write/run shows up as a unit moving on the map.

It ships as two cooperating pieces that talk over WebSocket and HTTP on
`localhost`:

- **`server/`** — a Node backend. Hosts real PTYs via `node-pty`, ingests tool
  events posted by the agent adapters, builds a world model, and streams it to
  connected game clients.
- **`command-and-clanker/`** — an OpenRA Mod SDK mod. A C# client connects to
  the backend, receives world updates, and renders them through the OpenRA
  engine.

The agent adapters in `integrations/` are the third leg: shims for Claude Code
and Codex that POST tool calls to the backend, but only when launched from
inside an in-game terminal (detected via the `CLANKER_SESSION` env var).

## Layout

- `server/` — TypeScript backend. `index.ts` is a thin composition root that
  wires the modules together and runs the tick loop; it holds no domain logic.
  The rest is split by layer:
  - Registries own domain state: `agents.ts` (`AgentRegistry`), `files.ts`
    (`FileRegistry`), `workdirs.ts` (`WorkDirTracker`).
  - Application services coordinate it: `ingest.ts` (the session-lifecycle
    state machine over the registries), `transcript-sync.ts` (tailer
    orchestration), `world-service.ts`, and `live.ts` (`Broadcaster`).
  - Transport: `http.ts` (route table) and `ws.ts` (`/live`, `/term`,
    `/termview` upgrades).
  - Pure helpers: `world-builder.ts` (touched dirs → spatial regions),
    `classify.ts`, `transcript.ts`.
  - Infrastructure: `terminals.ts` (PTY lifecycle), `persistence.ts`
    (snapshot/restore).

  Tests sit next to sources as `*.test.ts`.
- `shared/` — types shared between the backend and the adapters
  (`proc-types.ts`, `types.ts`).
- `command-and-clanker/` — the OpenRA mod. Contains an OpenRA SDK scaffold
  plus:
  - `mods/clanker/` — yaml rules, art, maps, and other mod data.
  - `OpenRA.Mods.Clanker/` — C# traits and widgets specific to this mod.
  - `engine/` — fetched OpenRA engine (not checked in; populated by
    `fetch-engine.sh` / `make`).
- `integrations/` — per-agent adapters wired up by `bun run setup`.
- `scripts/install.ts` — the setup script that installs those adapters.
- `docs/` — design notes (`architecture.md`). Read these for the why behind
  non-obvious choices.

## Runtimes and tooling

The split between Node and Bun is deliberate and load-bearing:

- The backend **runs under Node** because `node-pty` needs a real Node ABI.
  `bun run dev` and `bun run start` invoke `node` under the hood — do not
  swap them to `bun run`.
- **Tests run under Bun** (`bun test`). Test files use Bun's test runner
  conventions.
- `bun install` is the package manager. It compiles `node-pty` natively
  (needs `python3`, `make`, `g++`).
- TypeScript is executed via Node's `--experimental-strip-types`; there is no
  separate build step for the backend. `bun run typecheck` runs `tsc --noEmit`.
- The OpenRA mod builds with .NET 8 (or Mono) via `make` inside
  `command-and-clanker/`. The first build fetches and compiles the pinned
  engine and takes several minutes.
- `mise.toml` pins Bun and Node versions.

## Common commands

Run from the repo root unless noted:

- `bun install` — install backend deps.
- `bun run setup` — install the agent adapters into the user's agent configs.
- `bun run dev` — start the backend with `--watch`.
- `bun run start` — start the backend without watch.
- `bun run typecheck` — `tsc --noEmit` over the TypeScript sources.
- `bun test` — run all `*.test.ts` files.
- `bun run game` — build the mod and launch the game (also starts a backend).

Mod-only flow (from `command-and-clanker/`):

- `make` — fetch the engine on first run, then build the mod.
- `./launch-game.sh` / `./launch-dedicated.sh` — launch the game / a dedicated
  server.
- `./utility.sh` — OpenRA's utility CLI (map conversion, etc.).

## Conventions

- TypeScript is strict; prefer the shared types in `shared/` over redefining
  shapes locally. When the backend and an adapter exchange a payload, the
  type belongs in `shared/`.
- Keep `server/` modules small and pure where possible — `world-builder.ts`
  is the canonical example: events in, world state out, no I/O.
- Co-locate tests with the code they cover (`foo.ts` + `foo.test.ts`).
- The OpenRA mod follows OpenRA's own conventions for yaml rules and C#
  traits. When in doubt, mirror an existing trait in `OpenRA.Mods.Clanker/`
  or an existing rule in `mods/clanker/`.
- Mod assets (sprites, palettes, maps) live under `mods/clanker/`. Generated
  files under `command-and-clanker/engine/` and `bin/` are not checked in.
- Adapters in `integrations/` must stay silent outside a Command & Clanker
  session — gate all reporting on `CLANKER_SESSION`.

## Engineering standards

- Write self-documenting code. Default to zero comments; only add one when
  the *why* is non-obvious (a hidden constraint, a subtle invariant, a
  workaround for a specific bug). Never restate what the code does.
- Make atomic commits. Decompose each task into the smallest independently
  revertable units and commit one per unit, leaving the repo in a working
  state. Commit messages use an imperative subject under 72 characters,
  then a blank line and a body that explains *what* changed and *why*.
- Follow TDD when the situation permits — testable interface, test
  framework available, behaviour-bearing change. Red, green, refactor, in
  that order. State explicitly when TDD does not apply (spike, prototype,
  pure config or formatting change) before proceeding without tests.

## Things to avoid

- Do not commit anything under `command-and-clanker/engine/`,
  `command-and-clanker/bin/`, or `.clanker-cache.json` — these are
  build/runtime artefacts.
- Do not switch the backend off Node, or the test runner off Bun.
- Do not add comments that restate what the code does; follow the
  self-documenting-code rule from the engineering standards.
