import { readdir, readlink, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProcessSnapshot } from "../shared/proc-types.ts";

const DELETED_SUFFIX = / \(deleted\)$/;

export async function getRunningBinaryPaths(
  procPath = "/proc",
): Promise<string[]> {
  const snapshots = await getRunningProcesses(procPath);
  const paths = new Set<string>();
  for (const s of snapshots) paths.add(s.exe);
  return [...paths].sort();
}

export async function getRunningProcesses(
  procPath = "/proc",
): Promise<ProcessSnapshot[]> {
  let entries: string[];
  try {
    entries = await readdir(procPath);
  } catch {
    return [];
  }

  const out: ProcessSnapshot[] = [];
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

    out.push({ pid, exe, comm });
  }
  out.sort((a, b) => a.pid - b.pid);
  return out;
}
