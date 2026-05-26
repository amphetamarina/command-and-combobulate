import type Phaser from "phaser";
import type { Region } from "../shared/types.ts";
import { TILE_W, tileToScreen } from "./iso.ts";

export const FLOOR_COUNT = 8;
const THICKNESS = 14;
const SIDE_LEFT = 0x14171d;
const SIDE_RIGHT = 0x1d222b;
const EDGE_HI = 0x647082;

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

function floorVariant(x: number, y: number): number {
  return Math.abs((x * 73856093) ^ (y * 19349663)) % FLOOR_COUNT;
}

function centerScreen(r: Region): Pt {
  return tileToScreen(r.origin.x + r.size.w / 2, r.origin.y + r.size.h / 2);
}

// The deepest ancestor region whose path contains this one's path.
function parentOf(r: Region, regions: Region[]): Region | null {
  let best: Region | null = null;
  for (const o of regions) {
    if (o === r || o.path === r.path) continue;
    const prefix = o.path.endsWith("/") ? o.path : `${o.path}/`;
    if (!r.path.startsWith(prefix)) continue;
    if (!best || o.path.length > best.path.length) best = o;
  }
  return best;
}

const LINK_BASE = 0x1b2630;
const LINK_CORE = 0x3a5564;

// EXAPUNKS-style cables linking each island to its parent folder. Drawn below
// the island tops so they slip under the edges and only show across the gaps.
export function drawIslandLinks(
  g: Phaser.GameObjects.Graphics,
  regions: Region[],
): void {
  for (const r of regions) {
    const parent = parentOf(r, regions);
    if (!parent) continue;
    const a = centerScreen(r);
    const b = centerScreen(parent);
    g.lineStyle(4, LINK_BASE, 0.9);
    g.lineBetween(a.x, a.y, b.x, b.y);
    g.lineStyle(1.5, LINK_CORE, 0.85);
    g.lineBetween(a.x, a.y, b.x, b.y);
  }
}

// The extruded slab sides, drawn below the tiled top.
export function drawIslandSides(g: Phaser.GameObjects.Graphics, r: Region): void {
  const { E, S, W } = corners(r);
  const down = (p: Pt): Pt => ({ x: p.x, y: p.y + THICKNESS });
  g.fillStyle(SIDE_LEFT, 1);
  poly(g, [W, S, down(S), down(W)]);
  g.fillStyle(SIDE_RIGHT, 1);
  poly(g, [S, E, down(E), down(S)]);
}

// The island's top surface, stamped from the floor tile sprites.
export function paintIslandTop(
  blitterFor: (key: string) => Phaser.GameObjects.Blitter,
  r: Region,
  floorKeys: string[],
): void {
  const hw = TILE_W / 2;
  const { x: ox, y: oy } = r.origin;
  for (let y = oy; y < oy + r.size.h; y++) {
    for (let x = ox; x < ox + r.size.w; x++) {
      const s = tileToScreen(x, y);
      blitterFor(floorKeys[floorVariant(x, y)]!).create(s.x - hw, s.y);
    }
  }
}

// The beveled rim, drawn above the tiles: folder-tinted border + lit top edge.
export function drawIslandEdges(g: Phaser.GameObjects.Graphics, r: Region): void {
  const { N, E, S, W } = corners(r);
  g.lineStyle(2, r.tint, 0.9);
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
