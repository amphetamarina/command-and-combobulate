import { emptyCache, type PlacementCache } from "./world-builder.ts";

type Serialized = {
  region: [string, number][];
  building: [string, number][];
  freeRegionSlots: number[];
};

export async function loadCache(path: string): Promise<PlacementCache> {
  try {
    const data = JSON.parse(await Bun.file(path).text()) as Serialized;
    return {
      region: new Map(data.region ?? []),
      building: new Map(data.building ?? []),
      freeRegionSlots: data.freeRegionSlots ?? [],
    };
  } catch {
    return emptyCache();
  }
}

export async function saveCache(
  path: string,
  cache: PlacementCache,
): Promise<void> {
  const data: Serialized = {
    region: [...cache.region],
    building: [...cache.building],
    freeRegionSlots: cache.freeRegionSlots,
  };
  await Bun.write(path, JSON.stringify(data));
}
