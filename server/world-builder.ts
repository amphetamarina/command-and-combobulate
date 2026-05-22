import seedrandom from "seedrandom";
import type { BuildingDescriptor, ManifestEntry } from "../shared/types.ts";
import { BUILDING_SPRITE_KEYS } from "../shared/sprites.ts";

export const TILE_SPACING = 3;
const MAX_OFFSET = 0.5;
const SLOT_GRID_SIZE = 16;

export type PlacementCache = Map<string, number>;

export type BuildOptions = {
  district: string;
};

export function buildDistrict(
  manifest: ManifestEntry[],
  options: BuildOptions,
  cache: PlacementCache = new Map(),
): BuildingDescriptor[] {
  const sorted = [...manifest].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );

  let nextSlot = cache.size > 0
    ? Math.max(...cache.values()) + 1
    : 0;
  for (const entry of sorted) {
    if (!cache.has(entry.path)) {
      cache.set(entry.path, nextSlot++);
    }
  }

  return sorted.map((entry) => {
    const slot = cache.get(entry.path)!;
    const rng = seedrandom(entry.hash);
    const spriteKey =
      BUILDING_SPRITE_KEYS[
        Math.floor(rng() * BUILDING_SPRITE_KEYS.length)
      ]!;
    const offsetX = (rng() * 2 - 1) * MAX_OFFSET;
    const offsetY = (rng() * 2 - 1) * MAX_OFFSET;

    return {
      id: entry.path,
      district: options.district,
      tile: {
        x: (slot % SLOT_GRID_SIZE) * TILE_SPACING + offsetX,
        y: Math.floor(slot / SLOT_GRID_SIZE) * TILE_SPACING + offsetY,
      },
      footprint: { w: 1, h: 1 },
      spriteKey,
      hashShort: entry.hash.slice(0, 8),
      size: entry.size,
    };
  });
}
