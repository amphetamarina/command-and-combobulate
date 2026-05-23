import { test, expect } from "bun:test";
import { dirname } from "node:path";
import {
  buildWorld,
  emptyCache,
  releaseRegion,
  squareCell,
} from "./world-builder.ts";
import type { ManifestEntry } from "../shared/types.ts";
import { BUILDING_SPRITE_KEYS } from "../shared/sprites.ts";

const hex = (seed: number) =>
  Array.from({ length: 32 }, (_, i) =>
    ((seed * 31 + i) & 0xff).toString(16).padStart(2, "0"),
  ).join("");

const sampleManifest = (count: number, dir = "/usr/bin"): ManifestEntry[] =>
  Array.from({ length: count }, (_, i) => ({
    path: `${dir}/tool-${i.toString().padStart(3, "0")}`,
    hash: hex(i + 1),
    size: 1024 + i,
  }));

test("squareCell fills a near-square footprint for any count", () => {
  for (let n = 1; n <= 200; n++) {
    let maxCol = 0;
    let maxRow = 0;
    const seen = new Set<string>();
    for (let s = 0; s < n; s++) {
      const c = squareCell(s);
      seen.add(`${c.col},${c.row}`);
      maxCol = Math.max(maxCol, c.col);
      maxRow = Math.max(maxRow, c.row);
    }
    expect(seen.size).toBe(n);
    expect(Math.abs(maxCol - maxRow)).toBeLessThanOrEqual(1);
    const side = Math.ceil(Math.sqrt(n));
    expect(Math.max(maxCol, maxRow)).toBe(side - 1);
  }
});

test("returns one descriptor per manifest entry", () => {
  const { buildings } = buildWorld(sampleManifest(10));
  expect(buildings).toHaveLength(10);
});

test("descriptor ids match manifest paths", () => {
  const m = sampleManifest(5);
  const { buildings } = buildWorld(m);
  expect(buildings.map((d) => d.id).sort()).toEqual(m.map((e) => e.path).sort());
});

test("each building's district is its parent directory", () => {
  const m = [...sampleManifest(3, "/usr/bin"), ...sampleManifest(2, "/opt/x")];
  const { buildings } = buildWorld(m);
  for (const b of buildings) {
    expect(b.district).toBe(dirname(b.id));
  }
});

test("one region per distinct directory", () => {
  const m = [
    ...sampleManifest(3, "/usr/bin"),
    ...sampleManifest(2, "/usr/local/bin"),
    ...sampleManifest(1, "/opt/x"),
  ];
  const { regions } = buildWorld(m);
  expect(regions.map((r) => r.path).sort()).toEqual([
    "/opt/x",
    "/usr/bin",
    "/usr/local/bin",
  ]);
});

test("regions are laid out on a near-square meta-grid", () => {
  const dirs = ["/a", "/b", "/c", "/d", "/e"];
  const m = dirs.flatMap((d) => sampleManifest(1, d));
  const { regions } = buildWorld(m);
  const coords = regions.flatMap((r) => [r.origin.x, r.origin.y]);
  const stride = Math.min(...coords.filter((c) => c > 0));
  const cols = regions.map((r) => Math.round(r.origin.x / stride));
  const rows = regions.map((r) => Math.round(r.origin.y / stride));
  expect(Math.abs(Math.max(...cols) - Math.max(...rows))).toBeLessThanOrEqual(1);
});

test("region boxes never overlap", () => {
  const m = ["/a", "/b", "/c", "/d", "/e", "/f", "/g"].flatMap((d) =>
    sampleManifest(9, d),
  );
  const { regions } = buildWorld(m);
  for (let i = 0; i < regions.length; i++) {
    for (let j = i + 1; j < regions.length; j++) {
      const a = regions[i]!;
      const b = regions[j]!;
      const disjoint =
        a.origin.x + a.size.w <= b.origin.x ||
        b.origin.x + b.size.w <= a.origin.x ||
        a.origin.y + a.size.h <= b.origin.y ||
        b.origin.y + b.size.h <= a.origin.y;
      expect(disjoint).toBe(true);
    }
  }
});

test("every building sits inside its region's box", () => {
  const m = [...sampleManifest(7, "/usr/bin"), ...sampleManifest(4, "/opt/x")];
  const { buildings, regions } = buildWorld(m);
  const byPath = new Map(regions.map((r) => [r.path, r]));
  for (const b of buildings) {
    const r = byPath.get(b.district)!;
    expect(b.tile.x).toBeGreaterThanOrEqual(r.origin.x);
    expect(b.tile.x).toBeLessThanOrEqual(r.origin.x + r.size.w);
    expect(b.tile.y).toBeGreaterThanOrEqual(r.origin.y);
    expect(b.tile.y).toBeLessThanOrEqual(r.origin.y + r.size.h);
  }
});

test("tile keys are unique across all buildings", () => {
  const m = [...sampleManifest(10, "/usr/bin"), ...sampleManifest(8, "/opt/x")];
  const { buildings } = buildWorld(m);
  const keys = buildings.map((d) => `${d.tile.x},${d.tile.y}`);
  expect(new Set(keys).size).toBe(buildings.length);
});

test("any two buildings leave at least one walkable tile between them", () => {
  const m = [...sampleManifest(16, "/usr/bin"), ...sampleManifest(9, "/opt/x")];
  const { buildings } = buildWorld(m);
  for (let i = 0; i < buildings.length; i++) {
    for (let j = i + 1; j < buildings.length; j++) {
      const a = buildings[i]!.tile;
      const b = buildings[j]!.tile;
      const dx = Math.abs(a.x - b.x);
      const dy = Math.abs(a.y - b.y);
      expect(Math.max(dx, dy)).toBeGreaterThanOrEqual(2);
    }
  }
});

test("buildings receive sub-tile offsets so the grid is not perfectly aligned", () => {
  const { buildings } = buildWorld(sampleManifest(20));
  const someoneOffset = buildings.some(
    (d) =>
      d.tile.x !== Math.round(d.tile.x) || d.tile.y !== Math.round(d.tile.y),
  );
  expect(someoneOffset).toBe(true);
});

test("spriteKey is a known building sprite, footprint always 1x1", () => {
  const { buildings } = buildWorld(sampleManifest(50));
  for (const d of buildings) {
    expect(BUILDING_SPRITE_KEYS).toContain(d.spriteKey);
    expect(d.footprint).toEqual({ w: 1, h: 1 });
  }
});

test("hashShort is the first 8 hex chars of the hash", () => {
  const m = sampleManifest(3);
  const { buildings } = buildWorld(m);
  const byId = new Map(buildings.map((d) => [d.id, d]));
  for (const e of m) {
    expect(byId.get(e.path)?.hashShort).toBe(e.hash.slice(0, 8));
  }
});

test("size is carried through", () => {
  const m = sampleManifest(3);
  const { buildings } = buildWorld(m);
  const byId = new Map(buildings.map((d) => [d.id, d]));
  for (const e of m) {
    expect(byId.get(e.path)?.size).toBe(e.size);
  }
});

test("region tint is deterministic per directory", () => {
  const a = buildWorld(sampleManifest(1, "/usr/bin")).regions[0]!;
  const b = buildWorld(sampleManifest(3, "/usr/bin")).regions[0]!;
  expect(a.tint).toBe(b.tint);
  expect(typeof a.tint).toBe("number");
});

test("same hash always produces same appearance, regardless of position", () => {
  const sameHash = hex(42);
  const m1: ManifestEntry[] = [
    { path: "/usr/bin/a", hash: sameHash, size: 100 },
    { path: "/usr/bin/z", hash: hex(99), size: 100 },
  ];
  const m2: ManifestEntry[] = [
    { path: "/usr/bin/a", hash: hex(99), size: 100 },
    { path: "/usr/bin/z", hash: sameHash, size: 100 },
  ];
  const out1 = buildWorld(m1).buildings;
  const out2 = buildWorld(m2).buildings;
  const a1 = out1.find((d) => d.hashShort === sameHash.slice(0, 8))!;
  const a2 = out2.find((d) => d.hashShort === sameHash.slice(0, 8))!;
  expect(a1.spriteKey).toBe(a2.spriteKey);
  expect(a1.footprint).toEqual(a2.footprint);
});

test("output is byte-identical across runs (determinism contract)", () => {
  const m = [...sampleManifest(40, "/usr/bin"), ...sampleManifest(20, "/opt/x")];
  const out1 = buildWorld(m);
  const out2 = buildWorld(m);
  expect(JSON.stringify(out1)).toBe(JSON.stringify(out2));
});

test("output is stable when input is presented in a different order", () => {
  const m = [...sampleManifest(20, "/usr/bin"), ...sampleManifest(7, "/opt/x")];
  const shuffled = [...m].reverse();
  const byId = (w: ReturnType<typeof buildWorld>) =>
    Object.fromEntries(w.buildings.map((d) => [d.id, d]));
  expect(byId(buildWorld(m))).toEqual(byId(buildWorld(shuffled)));
});

test("adding a binary to an existing region keeps existing buildings in place", () => {
  const cache = emptyCache();
  const first = sampleManifest(5, "/usr/bin");
  const out1 = buildWorld(first, cache);

  const second = [
    ...first,
    { path: "/usr/bin/zzz-new", hash: "ff".repeat(32), size: 99 },
  ];
  const out2 = buildWorld(second, cache);

  const out1ById = new Map(out1.buildings.map((d) => [d.id, d.tile]));
  for (const d of out2.buildings) {
    const prev = out1ById.get(d.id);
    if (prev) expect(d.tile).toEqual(prev);
  }
});

test("a new directory becomes a new region without disturbing existing ones", () => {
  const cache = emptyCache();
  const out1 = buildWorld(sampleManifest(3, "/usr/bin"), cache);
  const usrBin1 = out1.regions.find((r) => r.path === "/usr/bin")!;

  const out2 = buildWorld(
    [...sampleManifest(3, "/usr/bin"), ...sampleManifest(1, "/opt/x")],
    cache,
  );
  const usrBin2 = out2.regions.find((r) => r.path === "/usr/bin")!;

  expect(usrBin2.origin).toEqual(usrBin1.origin);
  expect(out2.regions.map((r) => r.path).sort()).toEqual(["/opt/x", "/usr/bin"]);

  const out1ById = new Map(out1.buildings.map((d) => [d.id, d.tile]));
  for (const d of out2.buildings) {
    const prev = out1ById.get(d.id);
    if (prev) expect(d.tile).toEqual(prev);
  }
});

test("work directories become building-less regions of kind 'work'", () => {
  const m = sampleManifest(3, "/usr/bin");
  const { buildings, regions } = buildWorld(m, emptyCache(), [
    "/home/me/project/src",
  ]);
  const work = regions.find((r) => r.path === "/home/me/project/src")!;
  expect(work.kind).toBe("work");
  expect(regions.find((r) => r.path === "/usr/bin")!.kind).toBe("bin");
  expect(buildings.some((b) => b.district === "/home/me/project/src")).toBe(
    false,
  );
});

test("a work directory that also holds binaries stays a 'bin' region", () => {
  const m = sampleManifest(2, "/usr/bin");
  const { regions } = buildWorld(m, emptyCache(), ["/usr/bin"]);
  const usrBin = regions.filter((r) => r.path === "/usr/bin");
  expect(usrBin).toHaveLength(1);
  expect(usrBin[0]!.kind).toBe("bin");
});

test("work regions do not overlap bin regions", () => {
  const m = [...sampleManifest(9, "/usr/bin"), ...sampleManifest(4, "/opt/x")];
  const { regions } = buildWorld(m, emptyCache(), ["/var/data", "/tmp/work"]);
  for (let i = 0; i < regions.length; i++) {
    for (let j = i + 1; j < regions.length; j++) {
      const a = regions[i]!;
      const b = regions[j]!;
      const disjoint =
        a.origin.x + a.size.w <= b.origin.x ||
        b.origin.x + b.size.w <= a.origin.x ||
        a.origin.y + a.size.h <= b.origin.y ||
        b.origin.y + b.size.h <= a.origin.y;
      expect(disjoint).toBe(true);
    }
  }
});

test("a newly-touched work directory keeps existing regions in place", () => {
  const cache = emptyCache();
  const m = sampleManifest(3, "/usr/bin");
  const out1 = buildWorld(m, cache);
  const usrBin1 = out1.regions.find((r) => r.path === "/usr/bin")!;

  const out2 = buildWorld(m, cache, ["/var/log"]);
  const usrBin2 = out2.regions.find((r) => r.path === "/usr/bin")!;
  expect(usrBin2.origin).toEqual(usrBin1.origin);
  expect(out2.regions.some((r) => r.path === "/var/log")).toBe(true);
});

test("released region slots are reused by later directories", () => {
  const cache = emptyCache();
  buildWorld(sampleManifest(2, "/usr/bin"), cache, ["/a", "/b"]);
  const slotA = cache.region.get("/a")!;

  releaseRegion(cache, "/a");
  expect(cache.region.has("/a")).toBe(false);

  buildWorld(sampleManifest(2, "/usr/bin"), cache, ["/b", "/c"]);
  expect(cache.region.get("/c")).toBe(slotA);
});

test("releasing a region never reassigns a live region's slot", () => {
  const cache = emptyCache();
  buildWorld(sampleManifest(2, "/usr/bin"), cache, ["/a", "/b", "/c"]);
  releaseRegion(cache, "/b");
  buildWorld(sampleManifest(2, "/usr/bin"), cache, ["/a", "/c", "/d", "/e"]);
  const slots = [...cache.region.values()];
  expect(new Set(slots).size).toBe(slots.length);
});

test("placement cache assigns directories to incrementing region slots", () => {
  const cache = emptyCache();
  buildWorld(sampleManifest(2, "/usr/bin"), cache);
  expect(cache.region.get("/usr/bin")).toBe(0);
  buildWorld(
    [...sampleManifest(2, "/usr/bin"), ...sampleManifest(1, "/opt/x")],
    cache,
  );
  expect(cache.region.get("/opt/x")).toBe(1);
});
