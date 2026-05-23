import type { BuildingSpriteKey } from "./sprites.ts";

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
  spriteKey: BuildingSpriteKey;
  hashShort: string;
  size: number;
};

export type Region = {
  path: string;
  origin: { x: number; y: number };
  size: { w: number; h: number };
  tint: number;
};

export type World = {
  buildings: BuildingDescriptor[];
  regions: Region[];
};
