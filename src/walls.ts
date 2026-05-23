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

// The diamond's four edges are reflections of each other: crossing the
// vertical axis mirrors X, crossing the horizontal axis mirrors Y. The back
// edges (NW, NE) sit unflipped/X-flipped; the front edges (SE, SW) are their
// Y-mirror, so they also need flipY — same pattern the corners use.
type Flip = { flipX: boolean; flipY: boolean };
const EDGE_NW: Flip = { flipX: false, flipY: false }; // back-left  (x = x0)
const EDGE_NE: Flip = { flipX: true, flipY: false }; //  back-right (y = y0)
const EDGE_SE: Flip = { flipX: true, flipY: true }; //   front-right (x = x1)
const EDGE_SW: Flip = { flipX: false, flipY: true }; //  front-left (y = y1)

const CORNER_N: Flip = { flipX: false, flipY: false };
const CORNER_E: Flip = { flipX: true, flipY: false };
const CORNER_S: Flip = { flipX: true, flipY: true };
const CORNER_W: Flip = { flipX: false, flipY: true };

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

  const place = (tx: number, ty: number, key: string, flip: Flip) => {
    const s = tileToScreen(tx, ty);
    walls.push(
      scene.add
        .image(s.x, s.y + BASE_DY, key)
        .setOrigin(ORIGIN_X, ORIGIN_Y)
        .setFlipX(flip.flipX)
        .setFlipY(flip.flipY)
        .setDepth(tx + ty + DEPTH_BIAS),
    );
  };
  const straight = (tx: number, ty: number, flip: Flip) =>
    place(tx, ty, `wall/${WALL_VARIANT}`, flip);
  const corner = (tx: number, ty: number, flip: Flip) =>
    place(tx, ty, `wall/${CORNER_VARIANT}`, flip);

  for (let y = y0; y <= y1; y += STEP) straight(x0, y, EDGE_NW);
  for (let x = x0; x <= x1; x += STEP) straight(x, y0, EDGE_NE);
  for (let y = y0; y <= y1; y += STEP) straight(x1, y, EDGE_SE);
  for (let x = x0; x <= x1; x += STEP) straight(x, y1, EDGE_SW);

  corner(x0, y0, CORNER_N);
  corner(x1, y0, CORNER_E);
  corner(x1, y1, CORNER_S);
  corner(x0, y1, CORNER_W);

  return walls;
}
