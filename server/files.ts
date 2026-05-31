import { basename } from "node:path";
import { statSync } from "node:fs";
import { classifyFile } from "./classify.ts";
import type { FileEntry } from "../shared/proc-types.ts";

const FILES_PER_DIR = 24;

// Tracks the files an agent has touched, grouped by their parent folder, and
// projects them to the `files` wire message. Capped per folder, oldest-evicted.
export class FileRegistry {
  // dir -> (file path -> entry).
  private filesByDir = new Map<string, Map<string, FileEntry>>();

  constructor(private readonly cap = FILES_PER_DIR) {}

  record(
    dir: string,
    path: string,
    direction: "read" | "write",
    now: number,
  ): void {
    let m = this.filesByDir.get(dir);
    if (!m) {
      m = new Map();
      this.filesByDir.set(dir, m);
    }
    let size = 0;
    try {
      size = statSync(path).size;
    } catch {
      /* gone or unreadable */
    }
    m.set(path, {
      path,
      name: basename(path),
      size,
      direction,
      role: classifyFile(path),
      ts: now,
    });
    if (m.size > this.cap) {
      const oldest = [...m.values()].sort((a, b) => a.ts - b.ts)[0];
      if (oldest) m.delete(oldest.path);
    }
  }

  isTracked(path: string): boolean {
    for (const m of this.filesByDir.values()) if (m.has(path)) return true;
    return false;
  }

  forget(dir: string): void {
    this.filesByDir.delete(dir);
  }

  message(): string {
    const files = [...this.filesByDir.entries()].map(([dir, m]) => ({
      dir,
      entries: [...m.values()].sort((a, b) => b.ts - a.ts),
    }));
    return JSON.stringify({ kind: "files", files });
  }
}
