import seedrandom from "seedrandom";
import type { BuildingDescriptor, ManifestEntry } from "../shared/types.ts";
import { BUILDING_SPRITE_KEYS } from "../shared/sprites.ts";

export type BuildOptions = {
  district: string;
};

export function buildDistrict(
  manifest: ManifestEntry[],
  options: BuildOptions,
): BuildingDescriptor[] {
  const sorted = [...manifest].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );

  const gridSize = Math.max(1, Math.ceil(Math.sqrt(sorted.length)));

  return sorted.map((entry, index) => {
    const rng = seedrandom(entry.hash);
    const spriteKey =
      BUILDING_SPRITE_KEYS[
        Math.floor(rng() * BUILDING_SPRITE_KEYS.length)
      ]!;

    return {
      id: entry.path,
      district: options.district,
      tile: { x: index % gridSize, y: Math.floor(index / gridSize) },
      footprint: { w: 1, h: 1 },
      spriteKey,
      hashShort: entry.hash.slice(0, 8),
      size: entry.size,
    };
  });
}
