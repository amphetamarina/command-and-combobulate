import { test, expect, afterEach } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCache, saveCache } from "./persistence.ts";
import { buildWorld, emptyCache, type TerminalInfo } from "./world-builder.ts";

const term = (id: string): TerminalInfo => ({ id, label: id });

const path = join(tmpdir(), `clanker-cache-${process.pid}-${Date.now()}.json`);

afterEach(async () => {
  await rm(path, { force: true });
});

test("returns an empty cache when the file is missing", async () => {
  const cache = await loadCache(join(tmpdir(), "clanker-does-not-exist.json"));
  expect(cache.region.size).toBe(0);
  expect(cache.building.size).toBe(0);
  expect(cache.freeRegionSlots).toEqual([]);
});

test("round-trips region slot assignments", async () => {
  const cache = emptyCache();
  buildWorld([term("t1"), term("t2")], ["/var/log"], cache);

  await saveCache(path, cache);
  const loaded = await loadCache(path);

  expect([...loaded.region]).toEqual([...cache.region]);
  expect(loaded.freeRegionSlots).toEqual(cache.freeRegionSlots);
});

test("region positions stay stable when rebuilt with a reloaded cache", async () => {
  const terminals = [term("t1"), term("t2")];
  const workDirs = ["/var/log", "/home/me/project"];
  const first = emptyCache();
  const before = buildWorld(terminals, workDirs, first);
  await saveCache(path, first);

  const reloaded = await loadCache(path);
  const after = buildWorld(terminals, workDirs, reloaded);

  const originsOf = (w: ReturnType<typeof buildWorld>) =>
    Object.fromEntries(w.regions.map((r) => [r.path, r.origin]));
  expect(originsOf(after)).toEqual(originsOf(before));
});
