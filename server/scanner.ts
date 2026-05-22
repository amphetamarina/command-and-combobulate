import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ManifestEntry } from "../shared/types.ts";

export async function hashFile(path: string): Promise<ManifestEntry | null> {
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(path);
  } catch {
    return null;
  }
  if (!info.isFile()) return null;

  const bytes = await Bun.file(path).bytes();
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);
  return { path, hash: hasher.digest("hex"), size: info.size };
}

export async function scanPaths(paths: string[]): Promise<ManifestEntry[]> {
  const entries: ManifestEntry[] = [];
  for (const p of paths) {
    const e = await hashFile(p);
    if (e) entries.push(e);
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return entries;
}

export async function scanDirectory(dir: string): Promise<ManifestEntry[]> {
  const names = await readdir(dir);
  return scanPaths(names.map((n) => join(dir, n)));
}
