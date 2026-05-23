import type Phaser from "phaser";
import { TILE_H, tileToScreen } from "./iso.ts";

// One consistent straight variant reads as a continuous wall; cycling all of
// them looked like random rubble. Swap WALL_VARIANT to taste (1-12, not 7).
const WALL_VARIANT = 8;
const CORNER_VARIANT = 7;

export const WALL_KEYS = Array.from({ length: 12 }, (_, i) => `wall/${i + 1}`);

export function wallAssetUrl(index: number): string {
  return `/isotop-assets/sci-fi/walls/station/wall-${index
    .toString()
    .padStart(2, "0")}.png`;
}

// Tuning knobs. The base of a straight sprite contacts the ground near
// (px 31, py 95) of its 124x96 frame, so the anchor is left-of-centre and at
// the very bottom. A straight wall's base runs along a constant-x edge
// unflipped; the other edges mirror it. Flip booleans per edge and corner can
// only be confirmed from a render, so they live here.
const ORIGIN_X = 0.25;
const ORIGIN_Y = 0.98;
const STEP = 1;
const DEPTH_BIAS = -0.5;
// Walls anchor at the tile's south point (like buildings) so they rest on the
// ground instead of floating at the tile's top corner.
const BASE_DY = TILE_H;

const FLIP_NW = false; // back-left edge (x = x0)
const FLIP_NE = true; // back-right edge (y = y0)
const FLIP_SE = true; // front-right edge (x = x1)
const FLIP_SW = false; // front-left edge (y = y1)

type Corner = { flipX: boolean; flipY: boolean };
const CORNER_N: Corner = { flipX: false, flipY: false };
const CORNER_E: Corner = { flipX: true, flipY: false };
const CORNER_S: Corner = { flipX: true, flipY: true };
const CORNER_W: Corner = { flipX: false, flipY: true };

export function placeWalls(
  scene: Phaser.Scene,
  extentX: number,
  extentY: number,
  padding: number,
): Phaser.GameObjects.Image[] {
  const x0 = -padding;
  const y0 = -padding;
  const x1 = extentX + padding - 1;
  const y1 = extentY + padding - 1;
  const walls: Phaser.GameObjects.Image[] = [];

  const straight = (tx: number, ty: number, flipX: boolean) => {
    const s = tileToScreen(tx, ty);
    walls.push(
      scene.add
        .image(s.x, s.y + BASE_DY, `wall/${WALL_VARIANT}`)
        .setOrigin(ORIGIN_X, ORIGIN_Y)
        .setFlipX(flipX)
        .setDepth(tx + ty + DEPTH_BIAS),
    );
  };

  const corner = (tx: number, ty: number, c: Corner) => {
    const s = tileToScreen(tx, ty);
    walls.push(
      scene.add
        .image(s.x, s.y + BASE_DY, `wall/${CORNER_VARIANT}`)
        .setOrigin(ORIGIN_X, ORIGIN_Y)
        .setFlipX(c.flipX)
        .setFlipY(c.flipY)
        .setDepth(tx + ty + DEPTH_BIAS),
    );
  };

  for (let y = y0; y <= y1; y += STEP) straight(x0, y, FLIP_NW);
  for (let x = x0; x <= x1; x += STEP) straight(x, y0, FLIP_NE);
  for (let y = y0; y <= y1; y += STEP) straight(x1, y, FLIP_SE);
  for (let x = x0; x <= x1; x += STEP) straight(x, y1, FLIP_SW);

  corner(x0, y0, CORNER_N);
  corner(x1, y0, CORNER_E);
  corner(x1, y1, CORNER_S);
  corner(x0, y1, CORNER_W);

  return walls;
}
