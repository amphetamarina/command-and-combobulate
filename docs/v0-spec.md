# v0: aesthetic & determinism validation

## Goal

Answer one question before writing any more code: **does the deterministic
city look like something worth living in?**

We are not validating gameplay, performance, or live process visualization
in this milestone. Only the static, deterministic rendering of a single
district.

## Scope

In scope:

- A Bun project with a tiny HTTP server and a Phaser 3 frontend.
- Enumerate one directory: `/usr/bin`.
- For each regular file in `/usr/bin`, compute a SHA-256 of its contents
  and emit a `BuildingDescriptor`.
- Deterministically lay out those buildings in an isometric district.
- Render the district in the browser with pan and zoom.
- Hovering a building shows: full path, first 8 chars of hash, file size.

Out of scope (do not build these in v0):

- Reading `/proc`. No processes, no NPCs, no robots.
- WebSockets. REST only.
- Any directory other than `/usr/bin`.
- Multiple districts, roads between districts, world map.
- Sprites or hand-drawn art. Use solid-color isometric prisms generated at
  runtime. The point is to see if the *layout* feels right; art comes after.
- Persistence / caching of the manifest.
- Tauri or any desktop packaging.

## Stack

- Runtime: Bun (latest stable).
- Frontend bundler: Vite (Bun-compatible).
- Renderer: Phaser 3.
- Language: TypeScript on both sides.
- No additional state library. A single module-level store is fine at this
  scale.

Dependencies the v0 needs and nothing else:

- `phaser`
- `seedrandom` (deterministic PRNG)
- `vite` + `typescript` (dev)

## Determinism contract

The v0 must satisfy this property, and we will write a test for it:

> Given the same `/usr/bin` contents (i.e., the same list of files with the
> same SHA-256 hashes), the world builder produces byte-identical
> `BuildingDescriptor[]` output across runs and across machines.

Concretely:

- All random choices in the world builder go through `seedrandom`, seeded by
  a documented string. No `Math.random()`.
- Iteration order over the manifest is sorted by path, not filesystem order.
- Floating-point math in layout uses integer tile coordinates wherever
  possible; where it doesn't, round at the boundary.

## Layout algorithm (v0)

Keep it boring on purpose:

1. Sort manifest entries by path.
2. Pick a grid size `N x N` where `N = ceil(sqrt(count))`.
3. For each entry, assign a tile `(i % N, i / N)`. This is deterministic
   without needing a PRNG.
4. Building *appearance* (height tier 1-5, palette index 0-7, footprint
   1x1 or 2x2) is sampled from `seedrandom(hash)`.

A prettier algorithm (poisson disk, district shaping) comes after we know
the prism aesthetic works.

## Acceptance criteria

The v0 is done when all of the following hold:

1. `bun run dev` starts the backend and serves the frontend on a single
   port. No manual orchestration.
2. Opening the page renders an isometric district populated with one
   building per file in `/usr/bin`.
3. Pan with click-drag, zoom with wheel. Both work smoothly on a 4k display
   in WSLg.
4. Hovering a building shows a tooltip with path, hash prefix, size.
5. Running the determinism test twice on the same machine produces
   identical manifests.
6. Reloading the page produces the same layout pixel-for-pixel (modulo
   pan/zoom state).
7. The renderer code does not import anything from `node:fs` or know that
   `/usr/bin` exists. It only consumes `BuildingDescriptor[]` from the API.

## Atomic step breakdown (for commits)

Each step is one commit. Each must leave the repo in a working state.

1. Project skeleton: `package.json`, `tsconfig.json`, Vite config, empty
   `src/` and `server/`, working `bun run dev`.
2. Backend scanner: walk `/usr/bin`, hash contents, log a manifest. CLI
   only, no HTTP yet.
3. World builder module: pure function from manifest to
   `BuildingDescriptor[]`. Unit tested for determinism.
4. HTTP endpoint: `GET /world` returns the descriptors as JSON.
5. Phaser scene that renders a hard-coded `BuildingDescriptor[]`. No
   network yet.
6. Wire the frontend to fetch `/world` on startup.
7. Camera controls: pan + zoom.
8. Hover tooltip.
9. README with how to run, screenshot, and a note on what v0 deliberately
   does not do.

## Risks specific to v0

- **WSLg rendering quirks**: WebGL in WSLg has historically had occasional
  driver issues. If Phaser falls back to canvas, layout should still work
  but pan/zoom may judder. Acceptable for v0; flag if it happens.
- **`/usr/bin` size**: on a typical Debian, a few hundred to a couple
  thousand files. Hashing them all on first load is O(seconds). Acceptable;
  caching is post-v0.
- **Hash collisions in palette/height sampling**: with only ~8 palettes and
  5 height tiers, many buildings will look similar. This is fine for v0;
  visual variety comes from the post-v0 generator, not from collision
  avoidance.

## What we learn from v0

- Does the city look like something? (Aesthetic gut check.)
- Is the deterministic layout legible, or does it feel like a spreadsheet?
- Does Phaser's isometric story hold up, or do we want Pixi/Godot?
- Are the data shapes in `architecture.md` survivable, or do they fight us
  immediately?

If the answer to the first question is "no", we redesign before adding
processes, pipes, or any other dynamic layer. If the answer is "yes", the
next milestone is reading `/proc` and adding NPCs to the existing static
city.
