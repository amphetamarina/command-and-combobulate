import type { BuildingDescriptor } from "../shared/types.ts";
import { tileToScreen, UNIT_HEIGHT, type ScreenPoint } from "./iso.ts";

export function pointInPolygon(
  point: ScreenPoint,
  polygon: ScreenPoint[],
): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    const crosses =
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

export function buildingOutline(d: BuildingDescriptor): ScreenPoint[] {
  const { tile, footprint, heightTiers } = d;
  const z = heightTiers * UNIT_HEIGHT;
  const N = tileToScreen(tile.x, tile.y);
  const E = tileToScreen(tile.x + footprint.w, tile.y);
  const S = tileToScreen(tile.x + footprint.w, tile.y + footprint.h);
  const W = tileToScreen(tile.x, tile.y + footprint.h);

  return [
    { x: N.x, y: N.y - z },
    { x: E.x, y: E.y - z },
    { x: E.x, y: E.y },
    { x: S.x, y: S.y },
    { x: W.x, y: W.y },
    { x: W.x, y: W.y - z },
  ];
}
