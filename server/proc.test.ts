import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRunningBinaryPaths } from "./proc.ts";

const root = join(tmpdir(), `tty-proc-test-${process.pid}-${Date.now()}`);
const procPath = join(root, "proc");

const binA = join(root, "binA");
const binB = join(root, "binB");

beforeAll(async () => {
  await mkdir(procPath, { recursive: true });
  await writeFile(binA, "aaa");
  await writeFile(binB, "bbb");

  await mkdir(join(procPath, "100"));
  await symlink(binA, join(procPath, "100", "exe"));

  await mkdir(join(procPath, "200"));
  await symlink(binB, join(procPath, "200", "exe"));

  await mkdir(join(procPath, "300"));
  await symlink(binA, join(procPath, "300", "exe"));

  await mkdir(join(procPath, "400"));

  await mkdir(join(procPath, "self"));
  await symlink(binA, join(procPath, "self", "exe"));

  await mkdir(join(procPath, "500"));
  await symlink(`${binA} (deleted)`, join(procPath, "500", "exe"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

test("returns unique absolute paths from /proc/<pid>/exe", async () => {
  const paths = await getRunningBinaryPaths(procPath);
  expect(paths).toContain(binA);
  expect(paths).toContain(binB);
  expect(paths).toHaveLength(2);
});

test("ignores non-numeric proc entries like 'self'", async () => {
  const paths = await getRunningBinaryPaths(procPath);
  for (const p of paths) {
    expect(p.startsWith("/")).toBe(true);
  }
});

test("skips pids whose exe link is missing without throwing", async () => {
  const paths = await getRunningBinaryPaths(procPath);
  expect(paths).toBeDefined();
});

test("strips ' (deleted)' suffix from exe targets", async () => {
  const paths = await getRunningBinaryPaths(procPath);
  for (const p of paths) {
    expect(p).not.toContain("(deleted)");
  }
});

test("paths are sorted", async () => {
  const paths = await getRunningBinaryPaths(procPath);
  expect([...paths].sort()).toEqual(paths);
});

test("returns empty list when proc path does not exist", async () => {
  const paths = await getRunningBinaryPaths(join(root, "nope"));
  expect(paths).toEqual([]);
});
