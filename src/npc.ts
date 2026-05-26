import type { Region } from "../shared/types.ts";
import { toolFor } from "../shared/sprites.ts";
import { TILE_H, tileToScreen, type ScreenPoint } from "./iso.ts";

// Each walk spritesheet is 4 columns x 8 rows of 58x64 frames: one row per
// facing, four frames of walk-hover per row.
export const ROBOT_FRAME_W = 58;
export const ROBOT_FRAME_H = 64;
export const ROBOT_COLS = 4;

// Tools with bespoke robot art; every other process walks a generic chassis.
export const NAMED_ROBOTS = ["claude", "codex", "opencode"] as const;
export const GENERIC_ROBOTS = ["generic-1", "generic-2", "generic-3"] as const;
export const ROBOT_KEYS = [...NAMED_ROBOTS, ...GENERIC_ROBOTS] as const;
export type RobotKey = (typeof ROBOT_KEYS)[number];

export function robotTextureKey(key: RobotKey): string {
  return `robot/${key}`;
}

export function robotForExe(exe: string, pid: number): RobotKey {
  const tool = toolFor(exe);
  if (tool && (NAMED_ROBOTS as readonly string[]).includes(tool)) {
    return tool as RobotKey;
  }
  return GENERIC_ROBOTS[pid % GENERIC_ROBOTS.length]!;
}

// Row order of the walk sheets, top to bottom: each entry is the compass
// heading that row depicts. Flip entries here if a robot faces the wrong way.
export const SHEET_ROW_DIRS = [
  "S",
  "SW",
  "W",
  "NW",
  "N",
  "NE",
  "E",
  "SE",
] as const;
type Heading = (typeof SHEET_ROW_DIRS)[number];

// Screen-space compass, clockwise from due-east (the +x screen axis).
const COMPASS: readonly Heading[] = ["E", "SE", "S", "SW", "W", "NW", "N", "NE"];

export function headingFromScreen(dx: number, dy: number): Heading {
  if (dx === 0 && dy === 0) return "S";
  const step = Math.round(Math.atan2(dy, dx) / (Math.PI / 4));
  return COMPASS[((step % 8) + 8) % 8]!;
}

export function rowForHeading(h: Heading): number {
  const r = SHEET_ROW_DIRS.indexOf(h);
  return r < 0 ? 0 : r;
}

export const WANDER_OFFSETS: ReadonlyArray<{ x: number; y: number }> = [
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
  { x: 0, y: -1 },
  { x: 1, y: 1 },
  { x: 1, y: -1 },
  { x: -1, y: 1 },
  { x: -1, y: -1 },
];

export type NpcSpawn = {
  screen: ScreenPoint;
  tile: { x: number; y: number };
  tileSum: number;
};

// A home tile for a process inside its terminal island, spread across the
// island's interior by pid so siblings do not stack.
export function npcHome(pid: number, region: Region): NpcSpawn {
  const cols = Math.max(1, region.size.w - 2);
  const rows = Math.max(1, region.size.h - 2);
  const slot = ((pid % (cols * rows)) + cols * rows) % (cols * rows);
  const tx = region.origin.x + 1 + (slot % cols);
  const ty = region.origin.y + 1 + Math.floor(slot / cols);
  const s = tileToScreen(tx, ty);
  return {
    screen: { x: s.x, y: s.y + TILE_H / 2 },
    tile: { x: tx, y: ty },
    tileSum: tx + ty,
  };
}
