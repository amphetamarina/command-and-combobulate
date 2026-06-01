import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileRegistry } from "./files.ts";

describe("FileRegistry", () => {
  test("records a file and projects it to the wire message", () => {
    const reg = new FileRegistry();
    reg.record("/repo/src", "/repo/src/index.ts", "read", 1000);

    const msg = JSON.parse(reg.message());
    expect(msg.kind).toBe("files");
    expect(msg.files.length).toBe(1);
    const folder = msg.files[0];
    expect(folder.dir).toBe("/repo/src");
    expect(folder.entries.length).toBe(1);
    expect(folder.entries[0]).toMatchObject({
      path: "/repo/src/index.ts",
      name: "index.ts",
      direction: "read",
      role: "source",
      ts: 1000,
    });
    expect(typeof folder.entries[0].size).toBe("number");
  });

  test("sorts a folder's entries newest first", () => {
    const reg = new FileRegistry();
    reg.record("/repo", "/repo/a.ts", "read", 1);
    reg.record("/repo", "/repo/b.ts", "write", 3);
    reg.record("/repo", "/repo/c.ts", "read", 2);

    const { files } = JSON.parse(reg.message());
    const names = files[0].entries.map((e: { name: string }) => e.name);
    expect(names).toEqual(["b.ts", "c.ts", "a.ts"]);
  });

  test("re-recording the same path updates rather than duplicates", () => {
    const reg = new FileRegistry();
    reg.record("/repo", "/repo/a.ts", "read", 1);
    reg.record("/repo", "/repo/a.ts", "write", 5);

    const { files } = JSON.parse(reg.message());
    expect(files[0].entries.length).toBe(1);
    expect(files[0].entries[0].direction).toBe("write");
    expect(files[0].entries[0].ts).toBe(5);
  });

  test("evicts the oldest entry once a folder exceeds the cap", () => {
    const reg = new FileRegistry(3);
    reg.record("/repo", "/repo/a.ts", "read", 1);
    reg.record("/repo", "/repo/b.ts", "read", 2);
    reg.record("/repo", "/repo/c.ts", "read", 3);
    reg.record("/repo", "/repo/d.ts", "read", 4);

    const { files } = JSON.parse(reg.message());
    const names = files[0].entries.map((e: { name: string }) => e.name).sort();
    expect(names).toEqual(["b.ts", "c.ts", "d.ts"]);
    expect(reg.isTracked("/repo/a.ts")).toBe(false);
  });

  test("isTracked reflects recorded paths across folders", () => {
    const reg = new FileRegistry();
    reg.record("/repo/src", "/repo/src/a.ts", "read", 1);
    reg.record("/repo/test", "/repo/test/b.ts", "read", 1);

    expect(reg.isTracked("/repo/src/a.ts")).toBe(true);
    expect(reg.isTracked("/repo/test/b.ts")).toBe(true);
    expect(reg.isTracked("/repo/src/missing.ts")).toBe(false);
  });

  test("forget drops a folder's tracked files", () => {
    const reg = new FileRegistry();
    reg.record("/repo/src", "/repo/src/a.ts", "read", 1);
    reg.forget("/repo/src");

    expect(reg.isTracked("/repo/src/a.ts")).toBe(false);
    expect(JSON.parse(reg.message()).files.length).toBe(0);
  });
});

describe("FileRegistry size", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "combobulate-files-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("reads the real byte size of an existing file", () => {
    const path = join(dir, "data.txt");
    writeFileSync(path, "hello world");
    const reg = new FileRegistry();
    reg.record(dir, path, "read", 1);
    const { files } = JSON.parse(reg.message());
    expect(files[0].entries[0].size).toBe(11);
  });

  test("falls back to size 0 for a missing file", () => {
    const reg = new FileRegistry();
    reg.record("/nope", "/nope/ghost.ts", "read", 1);
    const { files } = JSON.parse(reg.message());
    expect(files[0].entries[0].size).toBe(0);
  });
});
