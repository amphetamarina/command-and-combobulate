import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanDirectory } from "./scanner.ts";

const root = join(tmpdir(), `tty-scanner-test-${process.pid}-${Date.now()}`);

beforeAll(async () => {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "b.bin"), "bbb");
  await writeFile(join(root, "a.bin"), "aaa");
  await mkdir(join(root, "subdir"));
  await writeFile(join(root, "subdir", "ignored.bin"), "x");
  await symlink(join(root, "a.bin"), join(root, "link-to-a"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

test("returns one entry per regular file in the directory", async () => {
  const m = await scanDirectory(root);
  const names = m.map((e) => e.path.split("/").pop());
  expect(names).toContain("a.bin");
  expect(names).toContain("b.bin");
  expect(names).not.toContain("subdir");
  expect(names).not.toContain("ignored.bin");
});

test("entries are sorted by path", async () => {
  const m = await scanDirectory(root);
  const paths = m.map((e) => e.path);
  const sorted = [...paths].sort();
  expect(paths).toEqual(sorted);
});

test("hash is 64-char lowercase hex", async () => {
  const m = await scanDirectory(root);
  for (const e of m) {
    expect(e.hash).toMatch(/^[0-9a-f]{64}$/);
  }
});

test("size matches file contents", async () => {
  const m = await scanDirectory(root);
  const a = m.find((e) => e.path.endsWith("a.bin"));
  expect(a?.size).toBe(3);
});

test("symlinks resolve to their target so identical content hashes identically", async () => {
  const m = await scanDirectory(root);
  const a = m.find((e) => e.path.endsWith("a.bin"));
  const link = m.find((e) => e.path.endsWith("link-to-a"));
  expect(link).toBeDefined();
  expect(link?.hash).toBe(a?.hash);
});

test("manifest is byte-identical across runs", async () => {
  const m1 = await scanDirectory(root);
  const m2 = await scanDirectory(root);
  expect(m1).toEqual(m2);
});
