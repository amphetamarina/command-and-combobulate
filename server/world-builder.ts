import seedrandom from "seedrandom";
import type { Region, World } from "../shared/types.ts";

// Every island is a fixed square; terminals are a touch bigger so several
// agent robots fit. A uniform stride keeps the meta-grid simple and gap-free.
const TERMINAL_SIZE = 6;
const WORK_SIZE = 4;
const REGION_GUTTER = 2;
const STRIDE = Math.max(TERMINAL_SIZE, WORK_SIZE) + REGION_GUTTER;

const TERMINAL_TINT = 0xff9ec7;
const WORK_TINTS = [
  0xc98aa6, 0xb88fb0, 0xc99a82, 0xa88fb8, 0xcf8f9a, 0x9a8fc0,
] as const;

export type TerminalInfo = { id: string; label: string };

export type PlacementCache = {
  region: Map<string, number>;
  building: Map<string, number>;
  freeRegionSlots: number[];
};

export function emptyCache(): PlacementCache {
  return { region: new Map(), building: new Map(), freeRegionSlots: [] };
}

export function releaseRegion(cache: PlacementCache, key: string): void {
  const slot = cache.region.get(key);
  if (slot === undefined) return;
  cache.region.delete(key);
  cache.freeRegionSlots.push(slot);
}

export function squareCell(slot: number): { col: number; row: number } {
  const ring = Math.floor(Math.sqrt(slot));
  const offset = slot - ring * ring;
  return offset <= ring
    ? { col: ring, row: offset }
    : { col: offset - ring - 1, row: ring };
}

type Item = { key: string; kind: Region["kind"]; label: string };

function assignSlots(items: Item[], cache: PlacementCache): void {
  const free = cache.freeRegionSlots.sort((a, b) => a - b);
  let next = Math.max(-1, ...cache.region.values(), ...free) + 1;
  for (const it of items) {
    if (cache.region.has(it.key)) continue;
    cache.region.set(it.key, free.length > 0 ? free.shift()! : next++);
  }
  cache.freeRegionSlots = free;
}

// The world is now agent-centric: one island per in-app terminal, plus one
// island per folder an agent is touching. No binaries, no buildings.
export function buildWorld(
  terminals: TerminalInfo[],
  workDirs: string[] = [],
  cache: PlacementCache = emptyCache(),
): World {
  const termKeys = new Set(terminals.map((t) => t.id));
  const items: Item[] = [
    ...terminals.map((t) => ({ key: t.id, kind: "terminal" as const, label: t.label })),
    ...workDirs
      .filter((d) => !termKeys.has(d))
      .map((d) => ({ key: d, kind: "work" as const, label: d })),
  ];
  if (items.length === 0) return { buildings: [], regions: [] };

  assignSlots(items, cache);

  const regions: Region[] = items.map((it) => {
    const cell = squareCell(cache.region.get(it.key)!);
    const side = it.kind === "terminal" ? TERMINAL_SIZE : WORK_SIZE;
    const rng = seedrandom(it.key);
    return {
      path: it.key,
      kind: it.kind,
      label: it.label,
      origin: { x: cell.col * STRIDE, y: cell.row * STRIDE },
      size: { w: side, h: side },
      tint:
        it.kind === "terminal"
          ? TERMINAL_TINT
          : WORK_TINTS[Math.floor(rng() * WORK_TINTS.length)]!,
    };
  });

  return { buildings: [], regions };
}
