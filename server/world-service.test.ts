import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorldService } from "./world-service.ts";
import { WorkDirTracker } from "./workdirs.ts";
import { emptyCache } from "./world-builder.ts";
import type { TerminalManager } from "./terminals.ts";

// A pid that will not exist, so the readlink in terminalInfos falls back to id.
const DEAD_PID = 2147483600;

function fakeTerminals(refs: { id: string; pid: number }[]): TerminalManager {
  return { refs: () => refs } as unknown as TerminalManager;
}

describe("WorldService", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "combobulate-world-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("builds a terminal region for each live terminal", async () => {
    const svc = new WorldService(
      fakeTerminals([{ id: "t1", pid: DEAD_PID }]),
      new WorkDirTracker(),
      emptyCache(),
      join(dir, "cache.json"),
    );
    const world = await svc.build();
    const term = world.regions.find((r) => r.path === "t1");
    expect(term).toBeDefined();
    expect(term?.kind).toBe("terminal");
  });

  test("includes touched work dirs as regions", async () => {
    const workDirs = new WorkDirTracker();
    workDirs.touch("/repo/src", 1);
    const svc = new WorldService(
      fakeTerminals([]),
      workDirs,
      emptyCache(),
      join(dir, "cache2.json"),
    );
    const world = await svc.build();
    expect(world.regions.some((r) => r.path === "/repo/src")).toBe(true);
  });

  test("persists the placement cache to disk", async () => {
    const cachePath = join(dir, "cache3.json");
    const svc = new WorldService(
      fakeTerminals([{ id: "t1", pid: DEAD_PID }]),
      new WorkDirTracker(),
      emptyCache(),
      cachePath,
    );
    await svc.build();
    // saveCache is fire-and-forget; allow the write to flush.
    await new Promise((r) => setTimeout(r, 50));
    expect(statSync(cachePath).size).toBeGreaterThan(0);
  });

  test("release recycles a placement slot without throwing", () => {
    const svc = new WorldService(
      fakeTerminals([]),
      new WorkDirTracker(),
      emptyCache(),
      join(dir, "cache4.json"),
    );
    expect(() => svc.release("t1")).not.toThrow();
  });
});
