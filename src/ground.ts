import type Phaser from "phaser";
import { tileToScreen } from "./iso.ts";

const TILE_COLOR_A = 0x1a1a28;
const TILE_COLOR_B = 0x14141e;
const TILE_STROKE = 0x24243a;

export function drawGround(
  g: Phaser.GameObjects.Graphics,
  extentX: number,
  extentY: number,
  padding: number,
): void {
  const x0 = -padding;
  const y0 = -padding;
  const x1 = extentX + padding;
  const y1 = extentY + padding;

  g.lineStyle(1, TILE_STROKE, 0.6);

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const N = tileToScreen(x, y);
      const E = tileToScreen(x + 1, y);
      const S = tileToScreen(x + 1, y + 1);
      const W = tileToScreen(x, y + 1);

      const fill = ((x + y) & 1) === 0 ? TILE_COLOR_A : TILE_COLOR_B;
      g.fillStyle(fill, 1);
      g.beginPath();
      g.moveTo(N.x, N.y);
      g.lineTo(E.x, E.y);
      g.lineTo(S.x, S.y);
      g.lineTo(W.x, W.y);
      g.closePath();
      g.fillPath();
      g.strokePath();
    }
  }
}
