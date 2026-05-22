import { test, expect } from "bun:test";
import { pointInPolygon, buildingOutline } from "./hit-test.ts";
import type { BuildingDescriptor } from "../shared/types.ts";
import { tileToScreen, UNIT_HEIGHT } from "./iso.ts";

const makeBuilding = (
  partial: Partial<BuildingDescriptor> = {},
): BuildingDescriptor => ({
  id: "/test",
  district: "running",
  tile: { x: 0, y: 0 },
  footprint: { w: 1, h: 1 },
  heightTiers: 2,
  paletteIndex: 0,
  hashShort: "deadbeef",
  size: 100,
  ...partial,
});

test("pointInPolygon returns true for a clearly interior point", () => {
  const square = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ];
  expect(pointInPolygon({ x: 5, y: 5 }, square)).toBe(true);
});

test("pointInPolygon returns false for a clearly exterior point", () => {
  const square = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ];
  expect(pointInPolygon({ x: 20, y: 20 }, square)).toBe(false);
  expect(pointInPolygon({ x: -1, y: 5 }, square)).toBe(false);
});

test("pointInPolygon works on a diamond (iso tile)", () => {
  const diamond = [
    { x: 0, y: -10 },
    { x: 20, y: 0 },
    { x: 0, y: 10 },
    { x: -20, y: 0 },
  ];
  expect(pointInPolygon({ x: 0, y: 0 }, diamond)).toBe(true);
  expect(pointInPolygon({ x: 15, y: 8 }, diamond)).toBe(false);
});

test("buildingOutline returns a 6-vertex polygon for a prism", () => {
  const poly = buildingOutline(makeBuilding());
  expect(poly).toHaveLength(6);
});

test("a point at the top center of the prism is inside the outline", () => {
  const b = makeBuilding({
    tile: { x: 2, y: 3 },
    footprint: { w: 1, h: 1 },
    heightTiers: 3,
  });
  const center = tileToScreen(2.5, 3.5);
  const topCenter = { x: center.x, y: center.y - 3 * UNIT_HEIGHT };
  expect(pointInPolygon(topCenter, buildingOutline(b))).toBe(true);
});

test("a point far from the prism is outside the outline", () => {
  const b = makeBuilding();
  expect(
    pointInPolygon({ x: 10_000, y: 10_000 }, buildingOutline(b)),
  ).toBe(false);
});
