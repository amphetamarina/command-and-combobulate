import seedrandom from "seedrandom";
import { dirname } from "node:path";
import type {
  BuildingDescriptor,
  ManifestEntry,
  Region,
  World,
} from "../shared/types.ts";
import { BUILDING_SPRITE_KEYS } from "../shared/sprites.ts";

export const TILE_SPACING = 3;
export const REGION_CELL_TILES = 30;
const MAX_OFFSET = 0.5;
const REGION_PADDING = 1;

const REGION_TINTS = [
  0x3a5f8a, 0x6a4a7a, 0x4a7a5a, 0x8a6a3a, 0x7a4a4a, 0x4a6a8a, 0x6a6a4a,
  0x5a4a8a,
] as const;

export type PlacementCache = {
  region: Map<string, number>;
  building: Map<string, number>;
};

export function emptyCache(): PlacementCache {
  return { region: new Map(), building: new Map() };
}

export function squareCell(slot: number): { col: number; row: number } {
  const ring = Math.floor(Math.sqrt(slot));
  const offset = slot - ring * ring;
  return offset <= ring
    ? { col: ring, row: offset }
    : { col: offset - ring - 1, row: ring };
}

function groupByDirectory(
  entries: ManifestEntry[],
): Map<string, ManifestEntry[]> {
  const groups = new Map<string, ManifestEntry[]>();
  for (const entry of entries) {
    const dir = dirname(entry.path);
    let group = groups.get(dir);
    if (!group) {
      group = [];
      groups.set(dir, group);
    }
    group.push(entry);
  }
  return groups;
}

function assignSlots(
  dirs: string[],
  groups: Map<string, ManifestEntry[]>,
  cache: PlacementCache,
): void {
  let nextRegion =
    cache.region.size > 0 ? Math.max(...cache.region.values()) + 1 : 0;
  for (const dir of dirs) {
    if (!cache.region.has(dir)) cache.region.set(dir, nextRegion++);
  }

  for (const dir of dirs) {
    const group = groups.get(dir)!;
    const taken = group
      .map((e) => cache.building.get(e.path))
      .filter((v): v is number => v !== undefined);
    let nextLocal = taken.length > 0 ? Math.max(...taken) + 1 : 0;
    for (const entry of group) {
      if (!cache.building.has(entry.path)) {
        cache.building.set(entry.path, nextLocal++);
      }
    }
  }
}

function buildRegion(
  dir: string,
  group: ManifestEntry[],
  cache: PlacementCache,
): { region: Region; buildings: BuildingDescriptor[] } {
  const regionCell = squareCell(cache.region.get(dir)!);
  const originX = regionCell.col * REGION_CELL_TILES;
  const originY = regionCell.row * REGION_CELL_TILES;

  let maxCol = 0;
  let maxRow = 0;
  const buildings: BuildingDescriptor[] = group.map((entry) => {
    const cell = squareCell(cache.building.get(entry.path)!);
    maxCol = Math.max(maxCol, cell.col);
    maxRow = Math.max(maxRow, cell.row);

    const rng = seedrandom(entry.hash);
    const spriteKey =
      BUILDING_SPRITE_KEYS[Math.floor(rng() * BUILDING_SPRITE_KEYS.length)]!;
    const offsetX = (rng() * 2 - 1) * MAX_OFFSET;
    const offsetY = (rng() * 2 - 1) * MAX_OFFSET;

    return {
      id: entry.path,
      district: dir,
      tile: {
        x: originX + REGION_PADDING + cell.col * TILE_SPACING + offsetX,
        y: originY + REGION_PADDING + cell.row * TILE_SPACING + offsetY,
      },
      footprint: { w: 1, h: 1 },
      spriteKey,
      hashShort: entry.hash.slice(0, 8),
      size: entry.size,
    };
  });

  const tintRng = seedrandom(dir);
  const region: Region = {
    path: dir,
    origin: { x: originX, y: originY },
    size: {
      w: (maxCol + 1) * TILE_SPACING + 2 * REGION_PADDING,
      h: (maxRow + 1) * TILE_SPACING + 2 * REGION_PADDING,
    },
    tint: REGION_TINTS[Math.floor(tintRng() * REGION_TINTS.length)]!,
  };

  return { region, buildings };
}

export function buildWorld(
  manifest: ManifestEntry[],
  cache: PlacementCache = emptyCache(),
): World {
  const sorted = [...manifest].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  const groups = groupByDirectory(sorted);
  const dirs = [...groups.keys()].sort();

  assignSlots(dirs, groups, cache);

  const buildings: BuildingDescriptor[] = [];
  const regions: Region[] = [];
  for (const dir of dirs) {
    const built = buildRegion(dir, groups.get(dir)!, cache);
    regions.push(built.region);
    buildings.push(...built.buildings);
  }

  return { buildings, regions };
}
