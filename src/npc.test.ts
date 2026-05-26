import { test, expect } from "bun:test";
import {
  GENERIC_ROBOTS,
  headingFromScreen,
  npcWorldPosition,
  robotForBuilding,
  rowForHeading,
  SHEET_ROW_DIRS,
} from "./npc.ts";
import type { BuildingDescriptor } from "../shared/types.ts";

const building: BuildingDescriptor = {
  id: "/usr/bin/bash",
  district: "running",
  tile: { x: 4, y: 6 },
  footprint: { w: 1, h: 1 },
  spriteKey: "building/foerderturm/1",
  hashShort: "00000000",
  size: 1,
};

test("robotForBuilding picks the matching tool robot", () => {
  expect(robotForBuilding("tool/claude", 1)).toBe("claude");
  expect(robotForBuilding("tool/codex", 2)).toBe("codex");
  expect(robotForBuilding("tool/opencode", 3)).toBe("opencode");
});

test("robotForBuilding falls back to a generic chassis", () => {
  expect(robotForBuilding("building/foerderturm/1", 0)).toBe(GENERIC_ROBOTS[0]);
  expect(robotForBuilding("tool/bun", 0)).toBe(GENERIC_ROBOTS[0]);
});

test("robotForBuilding spreads unknown pids across generic chassis", () => {
  const seen = new Set<string>();
  for (let pid = 0; pid < 30; pid++) {
    seen.add(robotForBuilding("building/foerderturm/1", pid));
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

test("npcWorldPosition is deterministic for a given pid and building", () => {
  const a = npcWorldPosition(123, building);
  const b = npcWorldPosition(123, building);
  expect(a).toEqual(b);
});

test("npcWorldPosition places different pids at different adjacent tiles", () => {
  const positions = new Set<string>();
  for (let pid = 0; pid < 4; pid++) {
    const p = npcWorldPosition(pid, building);
    positions.add(`${p.screen.x},${p.screen.y}`);
  }
  expect(positions.size).toBe(4);
});

test("npc tileSum is one greater or less than building's tile sum", () => {
  const buildingTileSum = building.tile.x + building.tile.y;
  for (let pid = 0; pid < 8; pid++) {
    const p = npcWorldPosition(pid, building);
    expect(Math.abs(p.tileSum - buildingTileSum)).toBe(1);
  }
});
