import type Phaser from "phaser";
import { tileToScreen } from "./iso.ts";

export const FLOOR_COUNT = 8;

const BUILDING_FLOOR = 3; // floor-04, metal grid pad
const REGION_FLOOR = 1; // floor-02, blue panel
const EMPTY_FLOOR = 5; // floor-06, plain dark

const DESERT_FREQ = 0.18;

export type RegionBox = { x0: number; y0: number; x1: number; y1: number };

export type GroundParams = {
  stationFloors: string[];
  desertFloors: string[];
  buildingPads: Set<string>;
  regions: RegionBox[];
  extentX: number;
  extentY: number;
  padding: number;
  desertMargin: number;
  depth: number;
};

function hash01(ix: number, iy: number): number {
  let h = (ix * 374761393 + iy * 668265263) >>> 0;
  h = (Math.imul(h ^ (h >>> 13), 1274126177) >>> 0) >>> 0;
  return h / 4294967295;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

function valueNoise(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = smooth(x - ix);
  const fy = smooth(y - iy);
  const a = hash01(ix, iy) + (hash01(ix + 1, iy) - hash01(ix, iy)) * fx;
  const b = hash01(ix, iy + 1) + (hash01(ix + 1, iy + 1) - hash01(ix, iy + 1)) * fx;
  return a + (b - a) * fy;
}

function inAnyRegion(x: number, y: number, regions: RegionBox[]): boolean {
  for (const r of regions) {
    if (x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1) return true;
  }
  return false;
}

export function buildGroundTiles(
  scene: Phaser.Scene,
  p: GroundParams,
): Phaser.GameObjects.Image[] {
  const tiles: Phaser.GameObjects.Image[] = [];
  const px0 = -p.padding;
  const py0 = -p.padding;
  const px1 = p.extentX + p.padding;
  const py1 = p.extentY + p.padding;

  const place = (x: number, y: number, key: string) => {
    const s = tileToScreen(x, y);
    tiles.push(
      scene.add.image(s.x, s.y, key).setOrigin(0.5, 0).setDepth(p.depth),
    );
  };

  for (let y = py0 - p.desertMargin; y < py1 + p.desertMargin; y++) {
    for (let x = px0 - p.desertMargin; x < px1 + p.desertMargin; x++) {
      const onStation = x >= px0 && x < px1 && y >= py0 && y < py1;
      if (onStation) {
        let idx = EMPTY_FLOOR;
        if (p.buildingPads.has(`${x},${y}`)) idx = BUILDING_FLOOR;
        else if (inAnyRegion(x, y, p.regions)) idx = REGION_FLOOR;
        place(x, y, p.stationFloors[idx]!);
        continue;
      }
      const dx = x < px0 ? px0 - x : x >= px1 ? x - (px1 - 1) : 0;
      const dy = y < py0 ? py0 - y : y >= py1 ? y - (py1 - 1) : 0;
      const dist = Math.max(dx, dy);
      const threshold = dist / (p.desertMargin + 1);
      if (valueNoise(x * DESERT_FREQ, y * DESERT_FREQ) > threshold) {
        const v = Math.floor(hash01(x, y) * p.desertFloors.length);
        place(x, y, p.desertFloors[v]!);
      }
    }
  }
  return tiles;
}
