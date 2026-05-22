import { test, expect } from "bun:test";
import { buildDistrict } from "./world-builder.ts";
import type { ManifestEntry } from "../shared/types.ts";
import { BUILDING_SPRITE_KEYS } from "../shared/sprites.ts";

const hex = (seed: number) =>
  Array.from({ length: 32 }, (_, i) =>
    ((seed * 31 + i) & 0xff).toString(16).padStart(2, "0"),
  ).join("");

const sampleManifest = (count: number): ManifestEntry[] =>
  Array.from({ length: count }, (_, i) => ({
    path: `/usr/bin/tool-${i.toString().padStart(3, "0")}`,
    hash: hex(i + 1),
    size: 1024 + i,
  }));

test("returns one descriptor per manifest entry", () => {
  const m = sampleManifest(10);
  const out = buildDistrict(m, { district: "/usr/bin" });
  expect(out).toHaveLength(10);
});

test("descriptor ids match manifest paths", () => {
  const m = sampleManifest(5);
  const out = buildDistrict(m, { district: "/usr/bin" });
  expect(out.map((d) => d.id)).toEqual(m.map((e) => e.path));
});

test("tile keys are unique across all buildings", () => {
  const m = sampleManifest(10);
  const out = buildDistrict(m, { district: "/usr/bin" });
  const tileKeys = out.map((d) => `${d.tile.x},${d.tile.y}`);
  expect(new Set(tileKeys).size).toBe(out.length);
});

test("buildings have at least one walkable tile between any two of them", () => {
  const m = sampleManifest(16);
  const out = buildDistrict(m, { district: "/usr/bin" });
  for (let i = 0; i < out.length; i++) {
    for (let j = i + 1; j < out.length; j++) {
      const a = out[i]!.tile;
      const b = out[j]!.tile;
      const dx = Math.abs(a.x - b.x);
      const dy = Math.abs(a.y - b.y);
      expect(Math.max(dx, dy)).toBeGreaterThanOrEqual(2);
    }
  }
});

test("buildings receive sub-tile offsets so the grid does not look perfectly aligned", () => {
  const m = sampleManifest(20);
  const out = buildDistrict(m, { district: "/usr/bin" });
  const someoneOffset = out.some(
    (d) => d.tile.x !== Math.round(d.tile.x) || d.tile.y !== Math.round(d.tile.y),
  );
  expect(someoneOffset).toBe(true);
});

test("spriteKey is a known building sprite, footprint always 1x1 in v0", () => {
  const m = sampleManifest(50);
  const out = buildDistrict(m, { district: "/usr/bin" });
  for (const d of out) {
    expect(BUILDING_SPRITE_KEYS).toContain(d.spriteKey);
    expect(d.footprint).toEqual({ w: 1, h: 1 });
  }
});

test("hashShort is the first 8 hex chars of the hash", () => {
  const m = sampleManifest(3);
  const out = buildDistrict(m, { district: "/usr/bin" });
  for (let i = 0; i < m.length; i++) {
    expect(out[i]?.hashShort).toBe(m[i]!.hash.slice(0, 8));
  }
});

test("size and district are carried through", () => {
  const m = sampleManifest(3);
  const out = buildDistrict(m, { district: "/usr/bin" });
  for (let i = 0; i < m.length; i++) {
    expect(out[i]?.size).toBe(m[i]!.size);
    expect(out[i]?.district).toBe("/usr/bin");
  }
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
  const out1 = buildDistrict(m1, { district: "/usr/bin" });
  const out2 = buildDistrict(m2, { district: "/usr/bin" });
  const a1 = out1.find((d) => d.hashShort === sameHash.slice(0, 8))!;
  const a2 = out2.find((d) => d.hashShort === sameHash.slice(0, 8))!;
  expect(a1.spriteKey).toBe(a2.spriteKey);
  expect(a1.footprint).toEqual(a2.footprint);
});

test("output is byte-identical across runs (determinism contract)", () => {
  const m = sampleManifest(100);
  const out1 = buildDistrict(m, { district: "/usr/bin" });
  const out2 = buildDistrict(m, { district: "/usr/bin" });
  expect(out1).toEqual(out2);
  expect(JSON.stringify(out1)).toBe(JSON.stringify(out2));
});

test("output is stable when input is presented in a different order", () => {
  const m = sampleManifest(20);
  const shuffled = [...m].reverse();
  const out1 = buildDistrict(m, { district: "/usr/bin" });
  const out2 = buildDistrict(shuffled, { district: "/usr/bin" });
  const byId = (arr: ReturnType<typeof buildDistrict>) =>
    Object.fromEntries(arr.map((d) => [d.id, d]));
  expect(byId(out1)).toEqual(byId(out2));
});

test("placement cache keeps existing buildings on the same tile when new ones are added", () => {
  const cache = new Map<string, number>();
  const first = sampleManifest(5);
  const out1 = buildDistrict(first, { district: "/usr/bin" }, cache);

  const second = [
    ...first,
    { path: "/usr/bin/zzz-new", hash: "ff".repeat(32), size: 99 },
  ];
  const out2 = buildDistrict(second, { district: "/usr/bin" }, cache);

  const out1ById = new Map(out1.map((d) => [d.id, d.tile]));
  for (const d of out2) {
    const prev = out1ById.get(d.id);
    if (prev) {
      expect(d.tile).toEqual(prev);
    }
  }
});

test("placement cache assigns new buildings to the next free slot", () => {
  const cache = new Map<string, number>();
  buildDistrict(sampleManifest(3), { district: "/usr/bin" }, cache);
  expect(Math.max(...cache.values())).toBe(2);
  buildDistrict(
    [
      ...sampleManifest(3),
      { path: "/usr/bin/zzz-new", hash: "ee".repeat(32), size: 1 },
    ],
    { district: "/usr/bin" },
    cache,
  );
  expect(cache.get("/usr/bin/zzz-new")).toBe(3);
});
