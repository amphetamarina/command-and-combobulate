import type Phaser from "phaser";
import { tileToScreen } from "./iso.ts";

const STRAIGHT_VARIANTS = [1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12];
const CORNER_VARIANT = 7;

export const WALL_KEYS = Array.from({ length: 12 }, (_, i) => `wall/${i + 1}`);

export function wallAssetUrl(index: number): string {
  return `/isotop-assets/sci-fi/walls/station/wall-${index
    .toString()
    .padStart(2, "0")}.png`;
}

// Tuning knobs for the back-edge wall border. The sprites share one base
// orientation, so one edge is mirrored; flip and vertical anchor can only be
// judged from a render, so they live here for easy adjustment.
const TILES_PER_WALL = 2; // a 124px wall spans two 62px tiles
const FLIP_NE_EDGE = false;
const FLIP_NW_EDGE = true;
const BASE_DY = 0;

export function placeWalls(
  scene: Phaser.Scene,
  extentX: number,
  extentY: number,
  padding: number,
): Phaser.GameObjects.Image[] {
  const x0 = -padding;
  const y0 = -padding;
  const x1 = extentX + padding;
  const y1 = extentY + padding;
  const walls: Phaser.GameObjects.Image[] = [];

  let cycle = 0;
  const straightKey = () =>
    `wall/${STRAIGHT_VARIANTS[cycle++ % STRAIGHT_VARIANTS.length]}`;

  const add = (
    tx: number,
    ty: number,
    key: string,
    flip: boolean,
    depthBias: number,
  ) => {
    const s = tileToScreen(tx, ty);
    const img = scene.add
      .image(s.x, s.y + BASE_DY, key)
      .setOrigin(0.5, 1)
      .setFlipX(flip);
    img.setDepth(tx + ty + depthBias);
    walls.push(img);
  };

  for (let x = x0; x <= x1; x += TILES_PER_WALL) {
    add(x, y0, straightKey(), FLIP_NE_EDGE, -0.5);
  }
  for (let y = y0; y <= y1; y += TILES_PER_WALL) {
    add(x0, y, straightKey(), FLIP_NW_EDGE, -0.5);
  }
  add(x0, y0, `wall/${CORNER_VARIANT}`, false, -1);

  return walls;
}
