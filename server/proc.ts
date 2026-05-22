import { readdir, readlink } from "node:fs/promises";
import { join } from "node:path";

const DELETED_SUFFIX = / \(deleted\)$/;

export async function getRunningBinaryPaths(
  procPath = "/proc",
): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(procPath);
  } catch {
    return [];
  }

  const paths = new Set<string>();
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const target = await readlink(join(procPath, name, "exe"));
      const cleaned = target.replace(DELETED_SUFFIX, "");
      if (cleaned.startsWith("/")) paths.add(cleaned);
    } catch {
      continue;
    }
  }
  return [...paths].sort();
}
