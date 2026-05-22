import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ManifestEntry } from "../shared/types.ts";

export async function scanDirectory(dir: string): Promise<ManifestEntry[]> {
  const names = await readdir(dir);
  const entries: ManifestEntry[] = [];

  for (const name of names) {
    const path = join(dir, name);

    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(path);
    } catch {
      continue;
    }
    if (!info.isFile()) continue;

    const bytes = await Bun.file(path).bytes();
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(bytes);
    const hash = hasher.digest("hex");

    entries.push({ path, hash, size: info.size });
  }

  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return entries;
}
