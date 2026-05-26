import { test, expect } from "bun:test";
import {
  GENERIC_ROBOTS,
  headingFromScreen,
  npcHome,
  robotForExe,
  rowForHeading,
  SHEET_ROW_DIRS,
} from "./npc.ts";
import type { Region } from "../shared/types.ts";

const region: Region = {
  path: "t1",
  kind: "terminal",
  label: "/home/me",
  origin: { x: 4, y: 6 },
  size: { w: 6, h: 6 },
  tint: 0xffffff,
};

test("robotForExe picks the matching tool robot", () => {
  expect(robotForExe("/home/me/.local/share/claude/versions/9/claude", 1)).toBe(
    "claude",
  );
  expect(robotForExe("/usr/bin/codex", 2)).toBe("codex");
  expect(robotForExe("/opt/opencode/opencode", 3)).toBe("opencode");
});

test("robotForExe falls back to a generic chassis", () => {
  expect(robotForExe("/usr/bin/bash", 0)).toBe(GENERIC_ROBOTS[0]);
  expect(robotForExe("/usr/bin/bun", 0)).toBe(GENERIC_ROBOTS[0]);
});

test("robotForExe spreads unknown pids across generic chassis", () => {
  const seen = new Set<string>();
  for (let pid = 0; pid < 30; pid++) {
    seen.add(robotForExe("/usr/bin/bash", pid));
  }
  expect(seen.size).toBe(GENERIC_ROBOTS.length);
});

test("headingFromScreen maps screen vectors to sheet rows", () => {
  expect(headingFromScreen(1, 0)).toBe("E");
  expect(headingFromScreen(0, 1)).toBe("S");
  expect(headingFromScreen(-1, 0)).toBe("W");
  expect(headingFromScreen(0, -1)).toBe("N");
  expect(headingFromScreen(0, 0)).toBe("S");
});

test("rowForHeading returns the sheet row index for each heading", () => {
  for (let row = 0; row < SHEET_ROW_DIRS.length; row++) {
    expect(rowForHeading(SHEET_ROW_DIRS[row]!)).toBe(row);
  }
});

test("npcHome is deterministic for a given pid and region", () => {
  expect(npcHome(123, region)).toEqual(npcHome(123, region));
});

test("npcHome places different pids at different tiles inside the island", () => {
  const positions = new Set<string>();
  for (let pid = 0; pid < 16; pid++) {
    const p = npcHome(pid, region);
    positions.add(`${p.tile.x},${p.tile.y}`);
  }
  expect(positions.size).toBe(16);
});

test("npcHome keeps the home tile inside the region's interior", () => {
  for (let pid = 0; pid < 30; pid++) {
    const p = npcHome(pid, region);
    expect(p.tile.x).toBeGreaterThan(region.origin.x);
    expect(p.tile.x).toBeLessThan(region.origin.x + region.size.w);
    expect(p.tile.y).toBeGreaterThan(region.origin.y);
    expect(p.tile.y).toBeLessThan(region.origin.y + region.size.h);
  }
});
