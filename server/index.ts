import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readlink } from "node:fs/promises";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { buildWorld, releaseRegion, type TerminalInfo } from "./world-builder.ts";
import { getRunningProcesses, ProcSampler } from "./proc.ts";
import { FileActivitySampler } from "./activity.ts";
import { loadCache, saveCache } from "./persistence.ts";
import { TerminalManager, type TermClient } from "./terminals.ts";
import type { World } from "../shared/types.ts";

const PORT = Number(process.env.TTY_API_PORT ?? 3001);
const TICK_MS = 1000;
const WORK_DIR_TTL_MS = 15000;
const CACHE_PATH =
  process.env.ISOTOP_CACHE ?? join(process.cwd(), ".isotop-cache.json");

const placements = await loadCache(CACHE_PATH);
const workDirLastActive = new Map<string, number>();
const knownTerminals = new Set<string>();
const sampler = new ProcSampler();
const activitySampler = new FileActivitySampler();
const terminals = new TerminalManager();
const liveClients = new Set<WebSocket>();

// A terminal island is labelled with the shell's current working directory.
async function terminalInfos(): Promise<TerminalInfo[]> {
  return Promise.all(
    terminals.refs().map(async ({ id, pid }) => {
      let label = id;
      try {
        label = await readlink(`/proc/${pid}/cwd`);
      } catch {
        /* keep id */
      }
      return { id, label };
    }),
  );
}

async function buildWorldFor(): Promise<World> {
  const infos = await terminalInfos();
  const world = buildWorld(infos, [...workDirLastActive.keys()], placements);
  void saveCache(CACHE_PATH, placements);
  return world;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function broadcast(message: string): void {
  for (const ws of liveClients) {
    if (ws.readyState === ws.OPEN) ws.send(message);
  }
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const { pathname } = url;
  const method = req.method ?? "GET";

  if (pathname === "/health") {
    return sendJson(res, 200, { status: "ok" });
  }

  if (pathname === "/term/new" && method === "POST") {
    let cols: number | undefined;
    let rows: number | undefined;
    try {
      const body = (await readBody(req)) as { cols?: number; rows?: number };
      cols = body.cols;
      rows = body.rows;
    } catch {
      /* defaults */
    }
    const id = terminals.create(cols, rows);
    console.log(`[term] created ${id} (${cols ?? 80}x${rows ?? 24})`);
    return sendJson(res, 200, { id });
  }

  if (pathname === "/term/kill" && method === "POST") {
    try {
      const { id } = (await readBody(req)) as { id?: unknown };
      terminals.kill(String(id));
      return sendJson(res, 200, { ok: true });
    } catch {
      return sendJson(res, 400, { ok: false });
    }
  }

  if (pathname === "/world") {
    const started = performance.now();
    const world = await buildWorldFor();
    const elapsedMs = Math.round(performance.now() - started);
    console.log(
      `[world] ${world.regions.length} islands in ${elapsedMs}ms`,
    );
    return sendJson(res, 200, world);
  }

  if (pathname === "/procs") {
    const processes = await getRunningProcesses("/proc", terminals.refs());
    return sendJson(res, 200, { capturedAt: Date.now(), processes });
  }

  if (pathname === "/kill" && method === "POST") {
    let pid: number;
    try {
      pid = Number((await readBody(req) as { pid?: unknown }).pid);
    } catch {
      return sendJson(res, 400, { ok: false, error: "bad request" });
    }
    if (!Number.isInteger(pid) || pid <= 1) {
      return sendJson(res, 400, { ok: false, error: "invalid pid" });
    }
    try {
      process.kill(pid, "SIGTERM");
      console.log(`[kill] sent SIGTERM to ${pid}`);
      return sendJson(res, 200, { ok: true, pid });
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: (err as Error).message });
    }
  }

  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
}

const httpServer = createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.warn(`[http] ${(err as Error).message}`);
    if (!res.headersSent) sendJson(res, 500, { error: "internal" });
  });
});

const wss = new WebSocketServer({ noServer: true });

httpServer.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/live") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      liveClients.add(ws);
      console.log("[ws] client connected");
      ws.on("close", () => {
        liveClients.delete(ws);
        console.log("[ws] client disconnected");
      });
    });
    return;
  }
  if (url.pathname === "/term") {
    const id = url.searchParams.get("id") ?? "";
    const term = terminals.get(id);
    if (!term) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const client: TermClient = {
        send: (data) => {
          if (ws.readyState === ws.OPEN) ws.send(data);
        },
      };
      term.attach(client);
      ws.on("message", (raw) => {
        const text = raw.toString();
        let msg: { i?: string; r?: [number, number] } | null = null;
        try {
          msg = JSON.parse(text);
        } catch {
          term.write(text);
          return;
        }
        if (typeof msg?.i === "string") term.write(msg.i);
        else if (Array.isArray(msg?.r)) term.resize(msg.r[0], msg.r[1]);
      });
      ws.on("close", () => term.detach(client));
    });
    return;
  }
  socket.destroy();
});

httpServer.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
  console.log(`[server] islands = your terminals and the folders their agents touch`);
});

setInterval(async () => {
  if (liveClients.size === 0) return;
  try {
    const processes = await sampler.sample("/proc", terminals.refs());
    const activity = await activitySampler.sample(processes.map((p) => p.pid));
    for (const p of processes) p.activity = activity.get(p.pid) ?? null;

    broadcast(
      JSON.stringify({ kind: "procs", capturedAt: Date.now(), processes }),
    );

    const now = Date.now();
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

    const liveTerms = new Set(terminals.list());
    const freshTerms = [...liveTerms].filter((id) => !knownTerminals.has(id));
    const goneTerms = [...knownTerminals].filter((id) => !liveTerms.has(id));
    for (const id of goneTerms) {
      knownTerminals.delete(id);
      releaseRegion(placements, id);
    }
    for (const id of freshTerms) knownTerminals.add(id);

    const worldChanged =
      freshTerms.length > 0 ||
      goneTerms.length > 0 ||
      freshWorkDirs.length > 0 ||
      expiredWorkDirs.length > 0;
    if (worldChanged) {
      const world = await buildWorldFor();
      broadcast(
        JSON.stringify({
          kind: "world-delta",
          buildings: [],
          regions: world.regions,
        }),
      );
      console.log(
        `[ws] world-delta: +${freshTerms.length}/-${goneTerms.length} terminals, +${freshWorkDirs.length}/-${expiredWorkDirs.length} work dirs, ${world.regions.length} islands`,
      );
    }
  } catch (err) {
    console.warn(`[tick] failed: ${(err as Error).message}`);
  }
}, TICK_MS);
