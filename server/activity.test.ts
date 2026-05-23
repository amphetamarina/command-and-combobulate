import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileActivitySampler } from "./activity.ts";

let root: string;
let procPath: string;

const RDONLY = "02100000";
const WRONLY = "02102001";

async function setFd(
  pid: number,
  fd: number,
  target: string,
  pos: number,
  flags: string,
) {
  const dir = join(procPath, String(pid));
  await mkdir(join(dir, "fd"), { recursive: true });
  await mkdir(join(dir, "fdinfo"), { recursive: true });
  await rm(join(dir, "fd", String(fd)), { force: true });
  await symlink(target, join(dir, "fd", String(fd)));
  await writeFile(
    join(dir, "fdinfo", String(fd)),
    `pos:\t${pos}\nflags:\t${flags}\nmnt_id:\t1\n`,
  );
}

async function setIo(pid: number, cwd: string, read: number, write: number) {
  const dir = join(procPath, String(pid));
  await mkdir(join(dir, "fd"), { recursive: true });
  await rm(join(dir, "cwd"), { force: true });
  await symlink(cwd, join(dir, "cwd"));
  await writeFile(
    join(dir, "io"),
    `rchar:\t${read}\nwchar:\t${write}\nread_bytes:\t0\nwrite_bytes:\t0\n`,
  );
}

beforeEach(async () => {
  root = join(tmpdir(), `tty-act-test-${process.pid}-${Date.now()}`);
  procPath = join(root, "proc");
  await mkdir(procPath, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("reports no activity on the first sample (no baseline)", async () => {
  await setFd(100, 5, "/data/project/log.txt", 0, WRONLY);
  const sampler = new FileActivitySampler();
  const out = await sampler.sample([100], procPath);
  expect(out.size).toBe(0);
});

test("detects a write when the file offset advances", async () => {
  await setFd(100, 5, "/data/project/log.txt", 0, WRONLY);
  const sampler = new FileActivitySampler();
  await sampler.sample([100], procPath);

  await setFd(100, 5, "/data/project/log.txt", 4096, WRONLY);
  const out = await sampler.sample([100], procPath);
  const a = out.get(100)!;
  expect(a.direction).toBe("write");
  expect(a.path).toBe("/data/project/log.txt");
  expect(a.dir).toBe("/data/project");
});

test("detects a read and reports its directory", async () => {
  await setFd(200, 3, "/home/me/notes/todo.md", 10, RDONLY);
  const sampler = new FileActivitySampler();
  await sampler.sample([200], procPath);

  await setFd(200, 3, "/home/me/notes/todo.md", 900, RDONLY);
  const out = await sampler.sample([200], procPath);
  expect(out.get(200)?.direction).toBe("read");
  expect(out.get(200)?.dir).toBe("/home/me/notes");
});

test("ignores files whose offset does not advance", async () => {
  await setFd(300, 4, "/data/idle.bin", 500, RDONLY);
  const sampler = new FileActivitySampler();
  await sampler.sample([300], procPath);
  const out = await sampler.sample([300], procPath);
  expect(out.has(300)).toBe(false);
});

test("ignores sockets, pipes, and device files", async () => {
  await setFd(400, 6, "socket:[12345]", 0, RDONLY);
  await setFd(400, 7, "/dev/null", 0, WRONLY);
  const sampler = new FileActivitySampler();
  await sampler.sample([400], procPath);
  await setFd(400, 6, "socket:[12345]", 9999, RDONLY);
  await setFd(400, 7, "/dev/null", 9999, WRONLY);
  const out = await sampler.sample([400], procPath);
  expect(out.has(400)).toBe(false);
});

test("reports the most active file when several advance", async () => {
  await setFd(500, 1, "/data/a/small.txt", 0, RDONLY);
  await setFd(500, 2, "/data/b/big.txt", 0, RDONLY);
  const sampler = new FileActivitySampler();
  await sampler.sample([500], procPath);

  await setFd(500, 1, "/data/a/small.txt", 100, RDONLY);
  await setFd(500, 2, "/data/b/big.txt", 100000, RDONLY);
  const out = await sampler.sample([500], procPath);
  expect(out.get(500)?.dir).toBe("/data/b");
});

test("falls back to the cwd when a process does bursty I/O with no streaming fd", async () => {
  await setIo(600, "/home/me/project", 0, 0);
  const sampler = new FileActivitySampler();
  await sampler.sample([600], procPath);

  await setIo(600, "/home/me/project", 0, 4 * 1024 * 1024);
  const out = await sampler.sample([600], procPath);
  const a = out.get(600)!;
  expect(a.dir).toBe("/home/me/project");
  expect(a.direction).toBe("write");
});

test("ignores trivial I/O below the byte threshold", async () => {
  await setIo(700, "/home/me/project", 0, 0);
  const sampler = new FileActivitySampler();
  await sampler.sample([700], procPath);

  await setIo(700, "/home/me/project", 1000, 1000);
  const out = await sampler.sample([700], procPath);
  expect(out.has(700)).toBe(false);
});

test("prefers a precise streaming file over the cwd fallback", async () => {
  await setFd(800, 5, "/data/stream.log", 0, WRONLY);
  await setIo(800, "/home/me/project", 0, 0);
  const sampler = new FileActivitySampler();
  await sampler.sample([800], procPath);

  await setFd(800, 5, "/data/stream.log", 8192, WRONLY);
  await setIo(800, "/home/me/project", 0, 4 * 1024 * 1024);
  const out = await sampler.sample([800], procPath);
  expect(out.get(800)?.path).toBe("/data/stream.log");
});
