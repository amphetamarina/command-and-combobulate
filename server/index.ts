import { join } from "node:path";
import { scanPaths } from "./scanner.ts";
import { buildWorld, releaseRegion } from "./world-builder.ts";
import {
  getRunningBinaryPaths,
  getRunningProcesses,
  ProcSampler,
} from "./proc.ts";
import { FileActivitySampler } from "./activity.ts";
import { loadCache, saveCache } from "./persistence.ts";
import { TerminalManager, type TermClient } from "./terminals.ts";
import type { World } from "../shared/types.ts";

const PORT = Number(process.env.TTY_API_PORT ?? 3001);
const TICK_MS = 1000;
const TOPIC = "isotop";
const WORK_DIR_TTL_MS = 15000;
const CACHE_PATH =
  process.env.ISOTOP_CACHE ?? join(process.cwd(), ".isotop-cache.json");

const placements = await loadCache(CACHE_PATH);
const knownExes = new Set<string>();
const workDirLastActive = new Map<string, number>();
const sampler = new ProcSampler();
const activitySampler = new FileActivitySampler();
const terminals = new TerminalManager();

type WSData =
  | { kind: "live" }
  | { kind: "term"; id: string; client?: TermClient };

async function buildWorldFor(paths: string[]): Promise<World> {
  const manifest = await scanPaths(paths);
  const world = buildWorld(manifest, placements, [...workDirLastActive.keys()]);
  void saveCache(CACHE_PATH, placements);
  return world;
}

const server = Bun.serve<WSData>({
  port: PORT,
  async fetch(req, srv) {
    const url = new URL(req.url);

    if (url.pathname === "/live") {
      if (srv.upgrade(req, { data: { kind: "live" } })) return undefined;
      return new Response("WS upgrade failed", { status: 400 });
    }

    if (url.pathname === "/term") {
      const id = url.searchParams.get("id") ?? "";
      if (!terminals.get(id)) return new Response("no such term", { status: 404 });
      if (srv.upgrade(req, { data: { kind: "term", id } })) return undefined;
      return new Response("WS upgrade failed", { status: 400 });
    }

    if (url.pathname === "/term/new" && req.method === "POST") {
      const id = terminals.create();
      console.log(`[term] created ${id}`);
      return Response.json({ id });
    }

    if (url.pathname === "/term/kill" && req.method === "POST") {
      let id = "";
      try {
        id = String((await req.json()).id);
      } catch {
        return Response.json({ ok: false }, { status: 400 });
      }
      terminals.kill(id);
      return Response.json({ ok: true });
    }

    if (url.pathname === "/health") {
      return Response.json({ status: "ok" });
    }

    if (url.pathname === "/world") {
      const started = performance.now();
      const paths = await getRunningBinaryPaths();
      for (const p of paths) knownExes.add(p);
      const world = await buildWorldFor(paths);
      const elapsedMs = Math.round(performance.now() - started);
      console.log(
        `[world] ${paths.length} unique exes -> ${world.buildings.length} buildings across ${world.regions.length} regions in ${elapsedMs}ms`,
      );
      return Response.json(world);
    }

    if (url.pathname === "/procs") {
      const processes = await getRunningProcesses();
      return Response.json({ capturedAt: Date.now(), processes });
    }

    if (url.pathname === "/kill" && req.method === "POST") {
      let pid: number;
      try {
        pid = Number((await req.json()).pid);
      } catch {
        return Response.json({ ok: false, error: "bad request" }, { status: 400 });
      }
      if (!Number.isInteger(pid) || pid <= 1) {
        return Response.json({ ok: false, error: "invalid pid" }, { status: 400 });
      }
      try {
        process.kill(pid, "SIGTERM");
        console.log(`[kill] sent SIGTERM to ${pid}`);
        return Response.json({ ok: true, pid });
      } catch (err) {
        return Response.json(
          { ok: false, error: (err as Error).message },
          { status: 400 },
        );
      }
    }

    return new Response("not found", { status: 404 });
  },
  websocket: {
    open(ws) {
      if (ws.data.kind === "term") {
        const term = terminals.get(ws.data.id);
        if (!term) {
          ws.close();
          return;
        }
        const client: TermClient = { send: (data) => ws.send(data) };
        ws.data.client = client;
        term.attach(client);
        return;
      }
      ws.subscribe(TOPIC);
      console.log("[ws] client connected");
    },
    close(ws) {
      if (ws.data.kind === "term" && ws.data.client) {
        terminals.get(ws.data.id)?.detach(ws.data.client);
        return;
      }
      console.log("[ws] client disconnected");
    },
    message(ws, message) {
      if (ws.data.kind === "term") {
        terminals.get(ws.data.id)?.write(
          typeof message === "string" ? message : message.toString(),
        );
      }
    },
  },
});

console.log(`[server] listening on http://localhost:${server.port}`);
console.log(`[server] regions = directories of currently running binaries`);

setInterval(async () => {
  if (server.subscriberCount(TOPIC) === 0) return;
  try {
    const processes = await sampler.sample();
    const activity = await activitySampler.sample(processes.map((p) => p.pid));
    for (const p of processes) p.activity = activity.get(p.pid) ?? null;

    server.publish(
      TOPIC,
      JSON.stringify({
        kind: "procs",
        capturedAt: Date.now(),
        processes,
      }),
    );

    const now = Date.now();
    const liveExes = new Set(processes.map((p) => p.exe));
    const freshExes: string[] = [];
    for (const e of liveExes) {
      if (!knownExes.has(e)) freshExes.push(e);
    }

    const freshWorkDirs: string[] = [];
    for (const a of activity.values()) {
      if (!workDirLastActive.has(a.dir)) freshWorkDirs.push(a.dir);
      workDirLastActive.set(a.dir, now);
    }
    const expiredWorkDirs: string[] = [];
    for (const [dir, last] of workDirLastActive) {
      if (now - last > WORK_DIR_TTL_MS) {
        workDirLastActive.delete(dir);
        releaseRegion(placements, dir);
        expiredWorkDirs.push(dir);
      }
    }

    const worldChanged =
      freshExes.length > 0 ||
      freshWorkDirs.length > 0 ||
      expiredWorkDirs.length > 0;
    if (worldChanged) {
      for (const e of freshExes) knownExes.add(e);
      const world = await buildWorldFor([...knownExes]);
      const freshSet = new Set(freshExes);
      const newBuildings = world.buildings.filter((b) => freshSet.has(b.id));
      server.publish(
        TOPIC,
        JSON.stringify({
          kind: "world-delta",
          buildings: newBuildings,
          regions: world.regions,
        }),
      );
      console.log(
        `[ws] world-delta: +${newBuildings.length} buildings, +${freshWorkDirs.length}/-${expiredWorkDirs.length} work dirs, ${world.regions.length} regions total`,
      );
    }
  } catch (err) {
    console.warn(`[tick] failed: ${(err as Error).message}`);
  }
}, TICK_MS);
