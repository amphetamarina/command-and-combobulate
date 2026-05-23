import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getRunningBinaryPaths,
  getRunningProcesses,
  ProcSampler,
} from "./proc.ts";

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
  await writeFile(join(procPath, "100", "comm"), "binA-runner\n");

  await mkdir(join(procPath, "200"));
  await symlink(binB, join(procPath, "200", "exe"));
  await writeFile(join(procPath, "200", "comm"), "binB-runner\n");

  await mkdir(join(procPath, "300"));
  await symlink(binA, join(procPath, "300", "exe"));
  await writeFile(join(procPath, "300", "comm"), "binA-other\n");

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

test("getRunningProcesses returns one snapshot per pid with exe and comm", async () => {
  const procs = await getRunningProcesses(procPath);
  const pids = procs.map((p) => p.pid).sort((a, b) => a - b);
  expect(pids).toEqual([100, 200, 300, 500]);
  const byPid = Object.fromEntries(procs.map((p) => [p.pid, p]));
  expect(byPid[100]?.exe).toBe(binA);
  expect(byPid[100]?.comm).toBe("binA-runner");
  expect(byPid[200]?.exe).toBe(binB);
  expect(byPid[200]?.comm).toBe("binB-runner");
});

test("getRunningProcesses keeps duplicate exes (one entry per pid)", async () => {
  const procs = await getRunningProcesses(procPath);
  const aRuns = procs.filter((p) => p.exe === binA);
  expect(aRuns.map((p) => p.pid).sort((a, b) => a - b)).toEqual([100, 300, 500]);
});

test("getRunningProcesses falls back to exe basename if comm is missing", async () => {
  const procs = await getRunningProcesses(procPath);
  const pid500 = procs.find((p) => p.pid === 500);
  expect(pid500?.comm).toBe("binA");
});

test("getRunningProcesses results are sorted by pid", async () => {
  const procs = await getRunningProcesses(procPath);
  const pids = procs.map((p) => p.pid);
  expect([...pids].sort((a, b) => a - b)).toEqual(pids);
});

test("getRunningProcesses reports zero cpu and mem when stat files are absent", async () => {
  const procs = await getRunningProcesses(procPath);
  for (const p of procs) {
    expect(p.cpu).toBe(0);
    expect(p.mem).toBe(0);
  }
});

const cpuRoot = join(tmpdir(), `tty-cpu-test-${process.pid}-${Date.now()}`);
const cpuProc = join(cpuRoot, "proc");
const cpuBin = join(cpuRoot, "bin");

const statLine = (utime: number, stime: number) =>
  `1 (proc) S ${Array(10).fill("0").join(" ")} ${utime} ${stime} 0 0\n`;

async function writePid(pid: number, jiffies: number, residentPages: number) {
  const dir = join(cpuProc, String(pid));
  await mkdir(dir, { recursive: true });
  await symlink(cpuBin, join(dir, "exe")).catch(() => {});
  await writeFile(join(dir, "comm"), `proc-${pid}\n`);
  await writeFile(join(dir, "stat"), statLine(jiffies, 0));
  await writeFile(join(dir, "statm"), `0 ${residentPages} 0 0 0 0 0\n`);
}

beforeAll(async () => {
  await mkdir(cpuProc, { recursive: true });
  await writeFile(cpuBin, "x");
  await writeFile(join(cpuProc, "stat"), "cpu 100 0 100 800 0 0 0\n");
  await writePid(700, 0, 100);
  await writePid(800, 0, 4000);
});

afterAll(async () => {
  await rm(cpuRoot, { recursive: true, force: true });
});

test("ProcSampler reports no cpu on the first sample (no prior baseline)", async () => {
  const sampler = new ProcSampler();
  const procs = await sampler.sample(cpuProc);
  for (const p of procs) expect(p.cpu).toBe(0);
});

test("ProcSampler derives cpu from jiffies consumed between samples", async () => {
  const sampler = new ProcSampler();
  await sampler.sample(cpuProc);

  await writeFile(join(cpuProc, "stat"), "cpu 200 0 100 1700 0 0 0\n");
  await writePid(700, 50, 100);
  await writePid(800, 0, 4000);

  const procs = await sampler.sample(cpuProc);
  const busy = procs.find((p) => p.pid === 700)!;
  const idle = procs.find((p) => p.pid === 800)!;
  expect(busy.cpu).toBeGreaterThan(0);
  expect(busy.cpu).toBeLessThanOrEqual(1);
  expect(idle.cpu).toBe(0);
});

test("ProcSampler reports memory as a fraction of total RAM", async () => {
  const sampler = new ProcSampler();
  const procs = await sampler.sample(cpuProc);
  const small = procs.find((p) => p.pid === 700)!;
  const large = procs.find((p) => p.pid === 800)!;
  expect(large.mem).toBeGreaterThan(small.mem);
  expect(small.mem).toBeGreaterThan(0);
  expect(large.mem).toBeLessThanOrEqual(1);
});
