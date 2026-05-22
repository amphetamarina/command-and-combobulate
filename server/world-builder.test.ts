import { test, expect } from "bun:test";
import { buildDistrict } from "./world-builder.ts";
import type { ManifestEntry } from "../shared/types.ts";

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

test("tiles fill a ceil(sqrt(n))-sized grid", () => {
  const m = sampleManifest(10);
  const out = buildDistrict(m, { district: "/usr/bin" });
  const n = Math.ceil(Math.sqrt(10));
  expect(n).toBe(4);
  for (const d of out) {
    expect(d.tile.x).toBeGreaterThanOrEqual(0);
    expect(d.tile.x).toBeLessThan(n);
    expect(d.tile.y).toBeGreaterThanOrEqual(0);
    expect(d.tile.y).toBeLessThan(n);
  }
  const tileKeys = out.map((d) => `${d.tile.x},${d.tile.y}`);
  expect(new Set(tileKeys).size).toBe(out.length);
});

test("heightTiers in [1,5], paletteIndex in [0,7], footprint w/h in {1,2}", () => {
  const m = sampleManifest(50);
  const out = buildDistrict(m, { district: "/usr/bin" });
  for (const d of out) {
    expect(d.heightTiers).toBeGreaterThanOrEqual(1);
    expect(d.heightTiers).toBeLessThanOrEqual(5);
    expect(d.paletteIndex).toBeGreaterThanOrEqual(0);
    expect(d.paletteIndex).toBeLessThanOrEqual(7);
    expect([1, 2]).toContain(d.footprint.w);
    expect([1, 2]).toContain(d.footprint.h);
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
  expect(a1.heightTiers).toBe(a2.heightTiers);
  expect(a1.paletteIndex).toBe(a2.paletteIndex);
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
