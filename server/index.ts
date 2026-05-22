import { scanPaths } from "./scanner.ts";
import { buildDistrict } from "./world-builder.ts";
import { getRunningBinaryPaths, getRunningProcesses } from "./proc.ts";

const PORT = Number(process.env.TTY_API_PORT ?? 3001);
const DISTRICT = "running";

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      return Response.json({ status: "ok" });
    }

    if (url.pathname === "/world") {
      const started = performance.now();
      const paths = await getRunningBinaryPaths();
      const manifest = await scanPaths(paths);
      const buildings = buildDistrict(manifest, { district: DISTRICT });
      const elapsedMs = Math.round(performance.now() - started);
      console.log(
        `[world] ${paths.length} unique exes -> ${buildings.length} buildings in ${elapsedMs}ms`,
      );
      return Response.json({ district: DISTRICT, buildings });
    }

    if (url.pathname === "/procs") {
      const processes = await getRunningProcesses();
      return Response.json({
        capturedAt: Date.now(),
        processes,
      });
    }

    return new Response("not found", { status: 404 });
  },
});

console.log(`[server] listening on http://localhost:${server.port}`);
console.log(`[server] district: ${DISTRICT} (universe = currently running binaries)`);
