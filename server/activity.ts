import { readdir, readlink, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { FileActivity } from "../shared/proc-types.ts";

const FD_SCAN_CAP = 256;
const SKIP_PREFIXES = ["/dev/", "/proc/", "/sys/", "/run/"];
const IO_ACTIVITY_MIN_BYTES = 256 * 1024;

function isTrackedFile(target: string): boolean {
  if (!target.startsWith("/")) return false;
  if (target === "/") return false;
  if (target.includes(":[")) return false;
  return !SKIP_PREFIXES.some((prefix) => target.startsWith(prefix));
}

function directionFromFlags(flags: number): "read" | "write" {
  return (flags & 3) === 0 ? "read" : "write";
}

type FdInfo = { pos: number; flags: number };

function parseFdInfo(text: string): FdInfo {
  let pos = 0;
  let flags = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("pos:")) pos = Number(line.slice(4).trim());
    else if (line.startsWith("flags:")) flags = parseInt(line.slice(6).trim(), 8);
  }
  return { pos, flags };
}

type IoCounters = { read: number; write: number };

async function readIo(pidDir: string): Promise<IoCounters | null> {
  try {
    const text = await readFile(join(pidDir, "io"), "utf8");
    let read = 0;
    let write = 0;
    for (const line of text.split("\n")) {
      if (line.startsWith("rchar:")) read = Number(line.slice(6).trim());
      else if (line.startsWith("wchar:")) write = Number(line.slice(6).trim());
    }
    return { read, write };
  } catch {
    return null;
  }
}

async function readCwd(pidDir: string): Promise<string | null> {
  try {
    return await readlink(join(pidDir, "cwd"));
  } catch {
    return null;
  }
}

export class FileActivitySampler {
  private prevPos = new Map<string, number>();
  private prevIo = new Map<number, IoCounters>();

  async sample(
    pids: number[],
    procPath = "/proc",
  ): Promise<Map<number, FileActivity>> {
    const out = new Map<number, FileActivity>();
    const nextPos = new Map<string, number>();
    const nextIo = new Map<number, IoCounters>();

    for (const pid of pids) {
      const pidDir = join(procPath, String(pid));
      const fdDir = join(pidDir, "fd");
      let fds: string[];
      try {
        fds = await readdir(fdDir);
      } catch {
        continue;
      }

      let best: { delta: number; activity: FileActivity } | null = null;
      for (const fd of fds.slice(0, FD_SCAN_CAP)) {
        let target: string;
        try {
          target = await readlink(join(fdDir, fd));
        } catch {
          continue;
        }
        if (!isTrackedFile(target)) continue;

        let info: FdInfo;
        try {
          info = parseFdInfo(await readFile(join(pidDir, "fdinfo", fd), "utf8"));
        } catch {
          continue;
        }

        const key = `${pid}:${fd}:${target}`;
        nextPos.set(key, info.pos);
        const prev = this.prevPos.get(key);
        if (prev !== undefined && info.pos > prev) {
          const delta = info.pos - prev;
          if (!best || delta > best.delta) {
            best = {
              delta,
              activity: {
                path: target,
                dir: dirname(target),
                direction: directionFromFlags(info.flags),
              },
            };
          }
        }
      }

      const io = await readIo(pidDir);
      if (io) nextIo.set(pid, io);

      if (best) {
        out.set(pid, best.activity);
      } else if (io) {
        const prevIo = this.prevIo.get(pid);
        if (prevIo) {
          const read = io.read - prevIo.read;
          const write = io.write - prevIo.write;
          if (read + write > IO_ACTIVITY_MIN_BYTES) {
            const cwd = await readCwd(pidDir);
            if (cwd && isTrackedFile(cwd)) {
              out.set(pid, {
                path: cwd,
                dir: cwd,
                direction: write > read ? "write" : "read",
              });
            }
          }
        }
      }
    }

    this.prevPos = nextPos;
    this.prevIo = nextIo;
    return out;
  }
}
