import { readdir, readlink, readFile } from "node:fs/promises";
import { cpus, totalmem } from "node:os";
import { join } from "node:path";
import type { ProcessSnapshot } from "../shared/proc-types.ts";

const DELETED_SUFFIX = / \(deleted\)$/;
const PAGE_SIZE = 4096;

type RawProcess = {
  pid: number;
  ppid: number;
  exe: string;
  comm: string;
  jiffies: number;
  rssBytes: number;
};

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

async function readStat(
  pidDir: string,
): Promise<{ ppid: number; jiffies: number }> {
  try {
    const stat = await readFile(join(pidDir, "stat"), "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return {
      ppid: Number(fields[1]) || 0,
      jiffies: Number(fields[11]) + Number(fields[12]),
    };
  } catch {
    return { ppid: 0, jiffies: 0 };
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

    const { ppid, jiffies } = await readStat(pidDir);
    const rssBytes = await readRssBytes(pidDir);
    procs.push({ pid, ppid, exe, comm, jiffies, rssBytes });
  }

  const totalJiffies = await readTotalJiffies(procPath);
  return { procs, totalJiffies };
}

// pids descending from any seed (the seeds themselves are excluded), so a
// terminal's shell and the commands it spawns are kept but the bun-spawned
// `script` wrapper is not.
export function descendantsOf(
  procs: { pid: number; ppid: number }[],
  seeds: number[],
): Set<number> {
  const childrenByParent = new Map<number, number[]>();
  for (const p of procs) {
    const list = childrenByParent.get(p.ppid);
    if (list) list.push(p.pid);
    else childrenByParent.set(p.ppid, [p.pid]);
  }
  const result = new Set<number>();
  const queue = [...seeds];
  while (queue.length > 0) {
    for (const child of childrenByParent.get(queue.shift()!) ?? []) {
      if (!result.has(child)) {
        result.add(child);
        queue.push(child);
      }
    }
  }
  return result;
}

function keep(procs: RawProcess[], seeds?: number[]): RawProcess[] {
  if (!seeds) return procs;
  const wanted = descendantsOf(procs, seeds);
  return procs.filter((p) => wanted.has(p.pid));
}

export type TerminalRef = { id: string; pid: number };

// Map each process to the id of the terminal it descends from. The first
// terminal in the list to claim a pid wins, which is fine since process
// trees do not overlap across terminals.
function attribution(
  procs: RawProcess[],
  terminals: TerminalRef[],
): Map<number, string> {
  const byPid = new Map<number, string>();
  for (const t of terminals) {
    for (const pid of descendantsOf(procs, [t.pid])) {
      if (!byPid.has(pid)) byPid.set(pid, t.id);
    }
  }
  return byPid;
}

function snapshotOf(
  p: RawProcess,
  terminal: string | null,
  cpu: number,
  ram: number,
): ProcessSnapshot {
  return {
    pid: p.pid,
    ppid: p.ppid,
    terminal,
    exe: p.exe,
    comm: p.comm,
    cpu,
    mem: ram > 0 ? clamp01(p.rssBytes / ram) : 0,
    activity: null,
  };
}

export async function getRunningBinaryPaths(
  procPath = "/proc",
  seeds?: number[],
): Promise<string[]> {
  const { procs } = await readRawProcesses(procPath);
  const paths = new Set<string>();
  for (const p of keep(procs, seeds)) paths.add(p.exe);
  return [...paths].sort();
}

export async function getRunningProcesses(
  procPath = "/proc",
  terminals?: TerminalRef[],
): Promise<ProcessSnapshot[]> {
  const { procs } = await readRawProcesses(procPath);
  const ram = totalmem();
  const attr = terminals ? attribution(procs, terminals) : null;
  const kept = attr ? procs.filter((p) => attr.has(p.pid)) : procs;
  return kept
    .map((p) => snapshotOf(p, attr?.get(p.pid) ?? null, 0, ram))
    .sort((a, b) => a.pid - b.pid);
}

export class ProcSampler {
  private prevJiffies = new Map<number, number>();
  private prevTotal = 0;
  private readonly cores = Math.max(1, cpus().length);

  async sample(
    procPath = "/proc",
    terminals?: TerminalRef[],
  ): Promise<ProcessSnapshot[]> {
    const { procs, totalJiffies } = await readRawProcesses(procPath);
    const ram = totalmem();
    const totalDelta = totalJiffies - this.prevTotal;
    const attr = terminals ? attribution(procs, terminals) : null;
    const kept = attr ? procs.filter((p) => attr.has(p.pid)) : procs;

    const snapshots = kept.map((p) => {
      const prev = this.prevJiffies.get(p.pid);
      const cpu =
        prev !== undefined && totalDelta > 0
          ? clamp01(((p.jiffies - prev) / totalDelta) * this.cores)
          : 0;
      return snapshotOf(p, attr?.get(p.pid) ?? null, cpu, ram);
    });

    this.prevJiffies = new Map(procs.map((p) => [p.pid, p.jiffies]));
    this.prevTotal = totalJiffies;
    return snapshots.sort((a, b) => a.pid - b.pid);
  }
}
