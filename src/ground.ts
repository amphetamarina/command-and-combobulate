import type Phaser from "phaser";
import { TILE_W, TILE_H } from "./iso.ts";

export const FLOOR_COUNT = 8;

function floorVariant(x: number, y: number): number {
  const h = Math.abs((x * 73856093) ^ (y * 19349663));
  return h % FLOOR_COUNT;
}

export function paintGround(
  rt: Phaser.GameObjects.RenderTexture,
  floorKeys: string[],
  extentX: number,
  extentY: number,
  padding: number,
): void {
  const hw = TILE_W / 2;
  const hh = TILE_H / 2;
  const x0 = -padding;
  const y0 = -padding;
  const x1 = extentX + padding;
  const y1 = extentY + padding;

  const left = (x0 - y1) * hw - hw;
  const top = (x0 + y0) * hh;
  const right = (x1 - y0) * hw + hw;
  const bottom = (x1 + y1) * hh + TILE_H;

  rt.setPosition(left, top);
  rt.setOrigin(0, 0);
  rt.resize(Math.ceil(right - left), Math.ceil(bottom - top));
  rt.clear();

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const sx = (x - y) * hw;
      const sy = (x + y) * hh;
      rt.draw(floorKeys[floorVariant(x, y)]!, sx - hw - left, sy - top);
    }
  }
}
