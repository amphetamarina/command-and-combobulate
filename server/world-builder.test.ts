import { test, expect } from "bun:test";
import {
  buildWorld,
  emptyCache,
  releaseRegion,
  squareCell,
  type TerminalInfo,
} from "./world-builder.ts";
import type { Region } from "../shared/types.ts";

const term = (id: string, label = id): TerminalInfo => ({ id, label });
const byPath = (regions: Region[]) =>
  new Map(regions.map((r) => [r.path, r]));
const contains = (parent: Region, child: Region) =>
  child.origin.x >= parent.origin.x &&
  child.origin.y >= parent.origin.y &&
  child.origin.x + child.size.w <= parent.origin.x + parent.size.w &&
  child.origin.y + child.size.h <= parent.origin.y + parent.size.h;
const disjoint = (a: Region, b: Region) =>
  a.origin.x + a.size.w <= b.origin.x ||
  b.origin.x + b.size.w <= a.origin.x ||
  a.origin.y + a.size.h <= b.origin.y ||
  b.origin.y + b.size.h <= a.origin.y;

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
    expect(Math.max(maxCol, maxRow)).toBe(Math.ceil(Math.sqrt(n)) - 1);
  }
});

test("each terminal becomes a level-0 terminal region", () => {
  const { regions } = buildWorld([term("t1"), term("t2")], []);
  const terms = regions.filter((r) => r.kind === "terminal");
  expect(terms.map((r) => r.path).sort()).toEqual(["t1", "t2"]);
  expect(terms.every((r) => r.level === 0)).toBe(true);
});

test("every touched folder becomes a work region", () => {
  const { regions } = buildWorld([term("t1")], ["/p", "/p/src", "/p/test"]);
  const work = regions.filter((r) => r.kind === "work").map((r) => r.path);
  expect(work.sort()).toEqual(["/p", "/p/src", "/p/test"]);
});

test("a subfolder nests inside its parent and is one level deeper", () => {
  const { regions } = buildWorld([term("t1")], ["/p", "/p/src"]);
  const m = byPath(regions);
  const parent = m.get("/p")!;
  const child = m.get("/p/src")!;
  expect(parent.level).toBe(0);
  expect(child.level).toBe(1);
  expect(contains(parent, child)).toBe(true);
});

test("sibling subfolders are contained and do not overlap each other", () => {
  const { regions } = buildWorld([term("t1")], ["/p", "/p/src", "/p/test"]);
  const m = byPath(regions);
  const parent = m.get("/p")!;
  const a = m.get("/p/src")!;
  const b = m.get("/p/test")!;
  expect(contains(parent, a)).toBe(true);
  expect(contains(parent, b)).toBe(true);
  expect(disjoint(a, b)).toBe(true);
});

test("a folder's file area stays clear of its child sub-islands", () => {
  const { regions } = buildWorld([term("t1")], ["/p", "/p/src"]);
  const m = byPath(regions);
  const parent = m.get("/p")!;
  const child = m.get("/p/src")!;
  expect(child.origin.y).toBeGreaterThanOrEqual(
    parent.fileArea.y + parent.fileArea.rows,
  );
});

test("a folder with no touched ancestor is a top-level root", () => {
  const { regions } = buildWorld([term("t1")], ["/a/b/c"]);
  const r = byPath(regions).get("/a/b/c")!;
  expect(r.level).toBe(0);
});

test("top-level islands (terminals and root folders) do not overlap", () => {
  const { regions } = buildWorld(
    [term("t1"), term("t2")],
    ["/a", "/a/x", "/b", "/b/y", "/c"],
  );
  const roots = regions.filter((r) => r.level === 0);
  for (let i = 0; i < roots.length; i++) {
    for (let j = i + 1; j < roots.length; j++) {
      expect(disjoint(roots[i]!, roots[j]!)).toBe(true);
    }
  }
});

test("work tint is deterministic per path; terminals share a tint", () => {
  const a = buildWorld([term("t1")], ["/x"]);
  const b = buildWorld([term("t9")], ["/x"]);
  expect(byPath(a.regions).get("/x")!.tint).toBe(
    byPath(b.regions).get("/x")!.tint,
  );
  expect(a.regions.find((r) => r.kind === "terminal")!.tint).toBe(
    b.regions.find((r) => r.kind === "terminal")!.tint,
  );
});

test("empty input yields an empty world", () => {
  expect(buildWorld([], [])).toEqual({ regions: [] });
});

test("a leaf folder's file strip seats a row of role buildings", () => {
  const { regions } = buildWorld([term("t1")], ["/p"]);
  const leaf = byPath(regions).get("/p")!;
  // Three 2-wide buildings stepped by 3 columns need at least 8 columns; the
  // strip is 3 rows so a 3-tall building fits.
  expect(leaf.fileArea.cols).toBeGreaterThanOrEqual(8);
  expect(leaf.fileArea.rows).toBe(3);
});

test("output is byte-identical across runs", () => {
  const t = [term("t1")];
  const w = ["/p", "/p/src", "/p/test"];
  expect(JSON.stringify(buildWorld(t, w))).toBe(JSON.stringify(buildWorld(t, w)));
});

test("adding a new root folder keeps existing roots in place", () => {
  const cache = emptyCache();
  const out1 = buildWorld([term("t1")], ["/a"], cache);
  const a1 = byPath(out1.regions).get("/a")!;
  const out2 = buildWorld([term("t1")], ["/a", "/x"], cache);
  const a2 = byPath(out2.regions).get("/a")!;
  expect(a2.origin).toEqual(a1.origin);
});

test("released region slots are reused by later roots", () => {
  const cache = emptyCache();
  buildWorld([term("t1")], ["/a", "/b"], cache);
  const slotA = cache.region.get("/a")!;
  releaseRegion(cache, "/a");
  buildWorld([term("t1")], ["/b", "/c"], cache);
  expect(cache.region.get("/c")).toBe(slotA);
});
