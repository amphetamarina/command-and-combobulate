export const TILE_W = 62;
export const TILE_H = 32;

export type ScreenPoint = { x: number; y: number };

export function tileToScreen(tileX: number, tileY: number): ScreenPoint {
  return {
    x: (tileX - tileY) * (TILE_W / 2),
    y: (tileX + tileY) * (TILE_H / 2),
  };
}
