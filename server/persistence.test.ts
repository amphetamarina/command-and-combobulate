import { test, expect, afterEach } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCache, saveCache } from "./persistence.ts";
import { buildWorld, emptyCache } from "./world-builder.ts";
import type { ManifestEntry } from "../shared/types.ts";

const path = join(tmpdir(), `isotop-cache-${process.pid}-${Date.now()}.json`);

afterEach(async () => {
  await rm(path, { force: true });
});

test("returns an empty cache when the file is missing", async () => {
  const cache = await loadCache(join(tmpdir(), "isotop-does-not-exist.json"));
  expect(cache.region.size).toBe(0);
  expect(cache.building.size).toBe(0);
  expect(cache.freeRegionSlots).toEqual([]);
});

test("round-trips region and building slot assignments", async () => {
  const cache = emptyCache();
  const manifest: ManifestEntry[] = [
    { path: "/usr/bin/grep", hash: "aa".repeat(32), size: 1 },
    { path: "/opt/tool/run", hash: "bb".repeat(32), size: 2 },
  ];
  buildWorld(manifest, cache, ["/var/log"]);

  await saveCache(path, cache);
  const loaded = await loadCache(path);

  expect([...loaded.region]).toEqual([...cache.region]);
  expect([...loaded.building]).toEqual([...cache.building]);
  expect(loaded.freeRegionSlots).toEqual(cache.freeRegionSlots);
});

test("positions stay stable when the same manifest is rebuilt with a reloaded cache", async () => {
  const manifest: ManifestEntry[] = [
    { path: "/usr/bin/grep", hash: "aa".repeat(32), size: 1 },
    { path: "/usr/bin/sed", hash: "cc".repeat(32), size: 1 },
    { path: "/opt/tool/run", hash: "bb".repeat(32), size: 2 },
  ];
  const first = emptyCache();
  const before = buildWorld(manifest, first);
  await saveCache(path, first);

  const reloaded = await loadCache(path);
  const after = buildWorld(manifest, reloaded);

  const tilesOf = (w: ReturnType<typeof buildWorld>) =>
    Object.fromEntries(w.buildings.map((b) => [b.id, b.tile]));
  expect(tilesOf(after)).toEqual(tilesOf(before));
});
