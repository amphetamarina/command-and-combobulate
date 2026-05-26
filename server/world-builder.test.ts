import { test, expect } from "bun:test";
import {
  buildWorld,
  emptyCache,
  releaseRegion,
  squareCell,
  type TerminalInfo,
} from "./world-builder.ts";

const term = (id: string, label = id): TerminalInfo => ({ id, label });

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

test("the world has no buildings", () => {
  const { buildings } = buildWorld([term("t1")], ["/a", "/b"]);
  expect(buildings).toEqual([]);
});

test("each terminal becomes a region of kind 'terminal'", () => {
  const { regions } = buildWorld([term("t1"), term("t2")], []);
  const terms = regions.filter((r) => r.kind === "terminal");
  expect(terms.map((r) => r.path).sort()).toEqual(["t1", "t2"]);
});

test("each work directory becomes a region of kind 'work'", () => {
  const { regions } = buildWorld([term("t1")], ["/home/me/project", "/var/log"]);
  const work = regions.filter((r) => r.kind === "work");
  expect(work.map((r) => r.path).sort()).toEqual(["/home/me/project", "/var/log"]);
});

test("terminal labels are carried through", () => {
  const { regions } = buildWorld([term("t1", "/home/me/code")], []);
  expect(regions.find((r) => r.path === "t1")!.label).toBe("/home/me/code");
});

test("region boxes never overlap", () => {
  const { regions } = buildWorld(
    [term("t1"), term("t2"), term("t3")],
    ["/a", "/b", "/c", "/d"],
  );
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

test("a folder that shares a name with a terminal id is not duplicated", () => {
  const { regions } = buildWorld([term("t1")], ["t1"]);
  expect(regions.filter((r) => r.path === "t1")).toHaveLength(1);
});

test("terminal tint is constant; work tint is deterministic per path", () => {
  const a = buildWorld([term("t1")], ["/x"]);
  const b = buildWorld([term("t9")], ["/x"]);
  const termA = a.regions.find((r) => r.kind === "terminal")!;
  const termB = b.regions.find((r) => r.kind === "terminal")!;
  expect(termA.tint).toBe(termB.tint);
  const workA = a.regions.find((r) => r.path === "/x")!;
  const workB = b.regions.find((r) => r.path === "/x")!;
  expect(workA.tint).toBe(workB.tint);
});

test("empty input yields an empty world", () => {
  expect(buildWorld([], [])).toEqual({ buildings: [], regions: [] });
});

test("output is byte-identical across runs", () => {
  const t = [term("t1"), term("t2")];
  const w = ["/a", "/b", "/c"];
  expect(JSON.stringify(buildWorld(t, w))).toBe(JSON.stringify(buildWorld(t, w)));
});

test("a new island keeps existing regions in place", () => {
  const cache = emptyCache();
  const out1 = buildWorld([term("t1")], ["/a"], cache);
  const t1a = out1.regions.find((r) => r.path === "t1")!;

  const out2 = buildWorld([term("t1")], ["/a", "/b"], cache);
  const t1b = out2.regions.find((r) => r.path === "t1")!;
  expect(t1b.origin).toEqual(t1a.origin);
  expect(out2.regions.some((r) => r.path === "/b")).toBe(true);
});

test("released region slots are reused by later islands", () => {
  const cache = emptyCache();
  buildWorld([term("t1")], ["/a", "/b"], cache);
  const slotA = cache.region.get("/a")!;

  releaseRegion(cache, "/a");
  expect(cache.region.has("/a")).toBe(false);

  buildWorld([term("t1")], ["/b", "/c"], cache);
  expect(cache.region.get("/c")).toBe(slotA);
});

test("releasing a region never reassigns a live region's slot", () => {
  const cache = emptyCache();
  buildWorld([term("t1")], ["/a", "/b", "/c"], cache);
  releaseRegion(cache, "/b");
  buildWorld([term("t1")], ["/a", "/c", "/d", "/e"], cache);
  const slots = [...cache.region.values()];
  expect(new Set(slots).size).toBe(slots.length);
});
