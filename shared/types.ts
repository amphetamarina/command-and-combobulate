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
  // A folder path for work islands, or a terminal id ("t1") for terminal
  // islands.
  path: string;
  kind: "terminal" | "work";
  label: string;
  origin: { x: number; y: number };
  size: { w: number; h: number };
  tint: number;
};

export type World = {
  buildings: BuildingDescriptor[];
  regions: Region[];
};
