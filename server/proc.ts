import { readdir, readlink, readFile } from "node:fs/promises";
import { cpus, totalmem } from "node:os";
import { join } from "node:path";
import type { ProcessSnapshot } from "../shared/proc-types.ts";

const DELETED_SUFFIX = / \(deleted\)$/;
const PAGE_SIZE = 4096;

type RawProcess = {
  pid: number;
  exe: string;
  comm: string;
  jiffies: number;
  rssBytes: number;
};

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

async function readCpuJiffies(pidDir: string): Promise<number> {
  try {
    const stat = await readFile(join(pidDir, "stat"), "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return Number(fields[11]) + Number(fields[12]);
  } catch {
    return 0;
  }
}

async function readRssBytes(pidDir: string): Promise<number> {
  try {
    const statm = await readFile(join(pidDir, "statm"), "utf8");
    return Number(statm.split(" ")[1]) * PAGE_SIZE;
  } catch {
    return 0;
  }
}

async function readTotalJiffies(procPath: string): Promise<number> {
  try {
    const stat = await readFile(join(procPath, "stat"), "utf8");
    const firstLine = stat.slice(0, stat.indexOf("\n"));
    return firstLine
      .split(/\s+/)
      .slice(1)
      .reduce((sum, n) => sum + (Number(n) || 0), 0);
  } catch {
    return 0;
  }
}

async function readRawProcesses(
  procPath: string,
): Promise<{ procs: RawProcess[]; totalJiffies: number }> {
  let entries: string[];
  try {
    entries = await readdir(procPath);
  } catch {
    return { procs: [], totalJiffies: 0 };
  }

  const procs: RawProcess[] = [];
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    const pidDir = join(procPath, name);

    let exe: string;
    try {
      const target = await readlink(join(pidDir, "exe"));
      exe = target.replace(DELETED_SUFFIX, "");
      if (!exe.startsWith("/")) continue;
    } catch {
      continue;
    }

    let comm = "";
    try {
      comm = (await readFile(join(pidDir, "comm"), "utf8")).trim();
    } catch {
      comm = exe.split("/").pop() ?? "";
    }

    const jiffies = await readCpuJiffies(pidDir);
    const rssBytes = await readRssBytes(pidDir);
    procs.push({ pid, exe, comm, jiffies, rssBytes });
  }

  const totalJiffies = await readTotalJiffies(procPath);
  return { procs, totalJiffies };
}

export async function getRunningBinaryPaths(
  procPath = "/proc",
): Promise<string[]> {
  const { procs } = await readRawProcesses(procPath);
  const paths = new Set<string>();
  for (const p of procs) paths.add(p.exe);
  return [...paths].sort();
}

export async function getRunningProcesses(
  procPath = "/proc",
): Promise<ProcessSnapshot[]> {
  const { procs } = await readRawProcesses(procPath);
  const ram = totalmem();
  return procs
    .map((p) => ({
      pid: p.pid,
      exe: p.exe,
      comm: p.comm,
      cpu: 0,
      mem: ram > 0 ? clamp01(p.rssBytes / ram) : 0,
    }))
    .sort((a, b) => a.pid - b.pid);
}

export class ProcSampler {
  private prevJiffies = new Map<number, number>();
  private prevTotal = 0;
  private readonly cores = Math.max(1, cpus().length);

  async sample(procPath = "/proc"): Promise<ProcessSnapshot[]> {
    const { procs, totalJiffies } = await readRawProcesses(procPath);
    const ram = totalmem();
    const totalDelta = totalJiffies - this.prevTotal;

    const snapshots = procs.map((p) => {
      const prev = this.prevJiffies.get(p.pid);
      const cpu =
        prev !== undefined && totalDelta > 0
          ? clamp01(((p.jiffies - prev) / totalDelta) * this.cores)
          : 0;
      return {
        pid: p.pid,
        exe: p.exe,
        comm: p.comm,
        cpu,
        mem: ram > 0 ? clamp01(p.rssBytes / ram) : 0,
      };
    });

    this.prevJiffies = new Map(procs.map((p) => [p.pid, p.jiffies]));
    this.prevTotal = totalJiffies;
    return snapshots.sort((a, b) => a.pid - b.pid);
  }
}
