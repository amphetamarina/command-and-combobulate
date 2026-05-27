# Command & Clanker: the idea

## Vision

An isometric 2D game that renders the player's live Unix environment as an
inhabited city. Binaries are buildings, directories are districts, running
processes are NPCs walking between them, and pipes are robots ferrying cargo
along streets. The system the player is sitting on becomes the level.

This is not a simulation of a Unix-like world. It is a faithful, visual
projection of *this* machine, right now.

## Two-layer model

The world is split into two layers with different rules:

- **Static layer (deterministic)**: terrain, district boundaries, street
  layout, building placement, building appearance. Derived from stable inputs
  (binary content hashes, directory paths, username, commit SHAs of repos in
  scope) via a seeded PRNG. Same inputs always produce the same world.
- **Dynamic layer (live)**: NPCs (processes from `/proc`), cargo robots
  (active pipes), inventory (open file descriptors), lighting (load average,
  time of day). Reflects the machine's current state and changes constantly.

The split matters because the deterministic layer is what makes the city feel
*yours*. The dynamic layer is what makes it feel alive. Mixing the two
ruins both.

## Core mappings

| Real | In-game |
|---|---|
| Executable in `$PATH` | Building. Footprint, height, and roof style derived from the binary's content hash. |
| Directory in the FHS | District with its own architectural style (`/etc` government, `/var/log` archives, `/tmp` market, `/home/<user>` residential, `/proc` ghost dimension). |
| Running process | NPC walking the streets. PID identifies it; PPID determines who it "follows". Lifetime matches the process. |
| Zombie process | Literal zombie NPC, wandering. |
| Active pipe | Cargo robot carrying a box from producer building to consumer building. Speed scales with throughput. |
| Open file descriptor | Item in an NPC's inventory. |
| Load average | Weather / time of day. |
| Repo commit SHA | Seasonal variation of the relevant district. |

## Design tenets

1. **Determinism is a feature**, not an implementation detail. The player
   should be able to point at a building and know that its shape comes from
   `sha256(/usr/bin/grep)`. Reinstalling the system with the same packages
   yields the same city. Upgrading `grep` is a visible renovation.
2. **No invented metaphors when a real one exists.** Unix already speaks in
   processes, parents, owners, pipes, signals. Use those words.
3. **The city must be legible.** A user who knows Unix should be able to look
   at the map and predict what they will find. A user who does not should be
   able to learn Unix by exploring.
4. **Read-only by default.** The game observes the system; it does not mutate
   it without an explicit player action with a confirmation.
5. **Local-first.** No data leaves the machine.

## Out of scope (for now)

- Multiplayer / shared cities.
- Editing the system from within the game.
- Cross-machine visualization (visiting a friend's city).
- A "sandbox" mode with a fictional Unix.

These may become interesting later, but they dilute the core idea if pursued
early.
