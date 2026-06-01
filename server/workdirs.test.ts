import { expect, test, describe } from "bun:test";
import { WorkDirTracker } from "./workdirs.ts";

describe("WorkDirTracker", () => {
  test("touch reports whether the dir is newly tracked", () => {
    const t = new WorkDirTracker();
    expect(t.touch("/repo/src", 1000)).toBe(true);
    expect(t.touch("/repo/src", 2000)).toBe(false);
  });

  test("keys lists every touched dir", () => {
    const t = new WorkDirTracker();
    t.touch("/a", 1);
    t.touch("/b", 1);
    expect(t.keys().sort()).toEqual(["/a", "/b"]);
  });

  test("evictIdle drops dirs idle past the ttl and returns them", () => {
    const t = new WorkDirTracker(6000);
    t.touch("/stale", 1000);
    t.touch("/fresh", 9000);

    const evicted = t.evictIdle(10000);

    expect(evicted).toEqual(["/stale"]);
    expect(t.keys()).toEqual(["/fresh"]);
  });

  test("evictIdle returns an empty list when nothing is idle", () => {
    const t = new WorkDirTracker(6000);
    t.touch("/a", 9000);
    expect(t.evictIdle(10000)).toEqual([]);
    expect(t.keys()).toEqual(["/a"]);
  });

  test("a fresh touch keeps a dir alive past a later eviction", () => {
    const t = new WorkDirTracker(6000);
    t.touch("/a", 1000);
    t.touch("/a", 9000);
    expect(t.evictIdle(10000)).toEqual([]);
    expect(t.keys()).toEqual(["/a"]);
  });
});
