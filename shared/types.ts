export type ManifestEntry = {
  path: string;
  hash: string;
  size: number;
};

export type BuildingDescriptor = {
  id: string;
  district: string;
  tile: { x: number; y: number };
  footprint: { w: number; h: number };
  heightTiers: number;
  paletteIndex: number;
  hashShort: string;
  size: number;
};
