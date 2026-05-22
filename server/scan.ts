import { scanDirectory } from "./scanner.ts";

const target = process.argv[2] ?? "/usr/bin";
const start = performance.now();
const manifest = await scanDirectory(target);
const elapsedMs = Math.round(performance.now() - start);

console.error(
  `[scan] ${target}: ${manifest.length} entries in ${elapsedMs}ms`,
);
console.log(JSON.stringify(manifest, null, 2));
