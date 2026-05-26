import type Phaser from "phaser";
import type { Region } from "../shared/types.ts";
import { tileToScreen } from "./iso.ts";

const THICKNESS = 14;
// Beveled slab faces, in a dark mauve so the pink top reads as lit.
const SIDE_LEFT = 0x342330;
const SIDE_RIGHT = 0x281a24;
// Top-edge highlight and folder-tinted outline.
const EDGE_HI = 0xf6d8e6;
const BORDER = 0xe7c2d2;
// Panel surfaces: a soft rose for plain folders, brighter for active ones.
const PANEL_NORMAL = 0xcb9fb4;
const PANEL_WORK = 0xe8b4cd;
const GRID_LINE = 0x5e3245;
const GRID_HI = 0xf6dbe7;

type Pt = { x: number; y: number };

function corners(r: Region): { N: Pt; E: Pt; S: Pt; W: Pt } {
  const { x: ox, y: oy } = r.origin;
  const { w, h } = r.size;
  return {
    N: tileToScreen(ox, oy),
    E: tileToScreen(ox + w, oy),
    S: tileToScreen(ox + w, oy + h),
    W: tileToScreen(ox, oy + h),
  };
}

function poly(g: Phaser.GameObjects.Graphics, pts: Pt[]): void {
  g.beginPath();
  g.moveTo(pts[0]!.x, pts[0]!.y);
  for (let i = 1; i < pts.length; i++) g.lineTo(pts[i]!.x, pts[i]!.y);
  g.closePath();
  g.fillPath();
}

export function regionCenter(r: Region): Pt {
  return tileToScreen(r.origin.x + r.size.w / 2, r.origin.y + r.size.h / 2);
}

const LINK_BASE = 0x0c0710;
const LINK_CORE = 0xe28bab;

// A cable between two island centers, drawn below the island tops so it slips
// under the edges and only shows across the gaps.
export function drawCable(
  g: Phaser.GameObjects.Graphics,
  a: Pt,
  b: Pt,
): void {
  g.lineStyle(8, LINK_BASE, 0.95);
  g.lineBetween(a.x, a.y, b.x, b.y);
  g.lineStyle(3.5, LINK_CORE, 0.95);
  g.lineBetween(a.x, a.y, b.x, b.y);
}

// The extruded slab sides, drawn below the panel top.
export function drawIslandSides(g: Phaser.GameObjects.Graphics, r: Region): void {
  const { E, S, W } = corners(r);
  const down = (p: Pt): Pt => ({ x: p.x, y: p.y + THICKNESS });
  g.fillStyle(SIDE_LEFT, 1);
  poly(g, [W, S, down(S), down(W)]);
  g.fillStyle(SIDE_RIGHT, 1);
  poly(g, [S, E, down(E), down(S)]);
}

// The island's flat top: a rose panel with a faint isometric grid that reads
// like a host's grid spaces.
export function drawIslandTop(g: Phaser.GameObjects.Graphics, r: Region): void {
  const { N, E, S, W } = corners(r);
  g.fillStyle(r.kind === "work" ? PANEL_WORK : PANEL_NORMAL, 1);
  poly(g, [N, E, S, W]);

  const { x: ox, y: oy } = r.origin;
  const { w, h } = r.size;
  const gridLine = (a: Pt, b: Pt) => {
    g.lineBetween(a.x, a.y, b.x, b.y);
  };
  // A bright lower-right shadow under each grid line plus the line itself,
  // so the cells read as crisply embossed squares.
  g.lineStyle(1, GRID_HI, 0.22);
  for (let i = 1; i < w; i++) {
    gridLine(tileToScreen(ox + i, oy + 0.06), tileToScreen(ox + i, oy + h + 0.06));
  }
  for (let j = 1; j < h; j++) {
    gridLine(tileToScreen(ox, oy + j + 0.06), tileToScreen(ox + w, oy + j + 0.06));
  }
  g.lineStyle(1, GRID_LINE, 0.7);
  for (let i = 1; i < w; i++) {
    gridLine(tileToScreen(ox + i, oy), tileToScreen(ox + i, oy + h));
  }
  for (let j = 1; j < h; j++) {
    gridLine(tileToScreen(ox, oy + j), tileToScreen(ox + w, oy + j));
  }
}

// The beveled rim, drawn above the panel: folder-tinted border + lit top edge.
export function drawIslandEdges(g: Phaser.GameObjects.Graphics, r: Region): void {
  const { N, E, S, W } = corners(r);
  g.lineStyle(2, BORDER, 0.85);
  g.beginPath();
  g.moveTo(N.x, N.y);
  g.lineTo(E.x, E.y);
  g.lineTo(S.x, S.y);
  g.lineTo(W.x, W.y);
  g.closePath();
  g.strokePath();
  g.lineStyle(2, EDGE_HI, 0.6);
  g.beginPath();
  g.moveTo(W.x, W.y);
  g.lineTo(N.x, N.y);
  g.lineTo(E.x, E.y);
  g.strokePath();
}
