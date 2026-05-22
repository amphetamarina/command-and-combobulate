import seedrandom from "seedrandom";
import type { BuildingDescriptor, ManifestEntry } from "../shared/types.ts";

const HEIGHT_TIERS = 5;
const PALETTE_COUNT = 8;

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
    const heightTiers = 1 + Math.floor(rng() * HEIGHT_TIERS);
    const paletteIndex = Math.floor(rng() * PALETTE_COUNT);
    const footprintRoll = rng();
    const footprint = footprintRoll < 0.15 ? { w: 2, h: 2 } : { w: 1, h: 1 };

    return {
      id: entry.path,
      district: options.district,
      tile: { x: index % gridSize, y: Math.floor(index / gridSize) },
      footprint,
      heightTiers,
      paletteIndex,
      hashShort: entry.hash.slice(0, 8),
      size: entry.size,
    };
  });
}
