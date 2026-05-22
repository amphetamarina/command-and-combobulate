import { scanPaths } from "./scanner.ts";
import { buildDistrict, type PlacementCache } from "./world-builder.ts";
import { getRunningBinaryPaths, getRunningProcesses } from "./proc.ts";
import type { BuildingDescriptor } from "../shared/types.ts";

const PORT = Number(process.env.TTY_API_PORT ?? 3001);
const DISTRICT = "running";
const TICK_MS = 1000;
const TOPIC = "isotop";

const placements: PlacementCache = new Map();
const knownExes = new Set<string>();

async function buildBuildingsFor(
  paths: string[],
): Promise<BuildingDescriptor[]> {
  const manifest = await scanPaths(paths);
  return buildDistrict(manifest, { district: DISTRICT }, placements);
}

const server = Bun.serve({
  port: PORT,
  async fetch(req, srv) {
    const url = new URL(req.url);

    if (url.pathname === "/live") {
      if (srv.upgrade(req)) return undefined;
      return new Response("WS upgrade failed", { status: 400 });
    }

    if (url.pathname === "/health") {
      return Response.json({ status: "ok" });
    }

    if (url.pathname === "/world") {
      const started = performance.now();
      const paths = await getRunningBinaryPaths();
      for (const p of paths) knownExes.add(p);
      const buildings = await buildBuildingsFor(paths);
      const elapsedMs = Math.round(performance.now() - started);
      console.log(
        `[world] ${paths.length} unique exes -> ${buildings.length} buildings in ${elapsedMs}ms`,
      );
      return Response.json({ district: DISTRICT, buildings });
    }

    if (url.pathname === "/procs") {
      const processes = await getRunningProcesses();
      return Response.json({ capturedAt: Date.now(), processes });
    }

    return new Response("not found", { status: 404 });
  },
  websocket: {
    open(ws) {
      ws.subscribe(TOPIC);
      console.log("[ws] client connected");
    },
    close() {
      console.log("[ws] client disconnected");
    },
    message() {},
  },
});

console.log(`[server] listening on http://localhost:${server.port}`);
console.log(`[server] district: ${DISTRICT} (universe = currently running binaries)`);

setInterval(async () => {
  if (server.subscriberCount(TOPIC) === 0) return;
  try {
    const processes = await getRunningProcesses();
    server.publish(
      TOPIC,
      JSON.stringify({
        kind: "procs",
        capturedAt: Date.now(),
        processes,
      }),
    );
    const liveExes = new Set(processes.map((p) => p.exe));
    const fresh: string[] = [];
    for (const e of liveExes) {
      if (!knownExes.has(e)) fresh.push(e);
    }
    if (fresh.length > 0) {
      for (const e of fresh) knownExes.add(e);
      const allBuildings = await buildBuildingsFor([...knownExes]);
      const freshSet = new Set(fresh);
      const newBuildings = allBuildings.filter((b) => freshSet.has(b.id));
      server.publish(
        TOPIC,
        JSON.stringify({ kind: "world-delta", buildings: newBuildings }),
      );
      console.log(
        `[ws] pushed world-delta with ${newBuildings.length} new buildings`,
      );
    }
  } catch (err) {
    console.warn(`[tick] failed: ${(err as Error).message}`);
  }
}, TICK_MS);
