import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, readlink } from "node:fs/promises";
import { statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { buildWorld, releaseRegion, type TerminalInfo } from "./world-builder.ts";
import { loadCache, saveCache } from "./persistence.ts";
import { TerminalManager, type TermClient } from "./terminals.ts";
import type { World } from "../shared/types.ts";
import type {
  AgentSnapshot,
  FileActivity,
  FileEntry,
} from "../shared/proc-types.ts";

const PORT = Number(process.env.TTY_API_PORT ?? 3001);
const TICK_MS = 1000;
const WORK_DIR_TTL_MS = 45000;
const ACTIVITY_TTL_MS = 6000;
const FILES_PER_DIR = 24;
const FILE_MAX_BYTES = 256 * 1024;
const CACHE_PATH =
  process.env.CLANKER_CACHE ?? join(process.cwd(), ".clanker-cache.json");
const INGEST_TOKEN = process.env.CLANKER_TOKEN ?? randomUUID();

const placements = await loadCache(CACHE_PATH);
const workDirLastActive = new Map<string, number>();
// dir -> (file path -> entry): the files an agent has touched in each folder.
const filesByDir = new Map<string, Map<string, FileEntry>>();
const knownTerminals = new Set<string>();
const liveClients = new Set<WebSocket>();
let worldDirty = false;

// Absolute paths to the adapters, injected as CLANKER_PATH (Claude plugin dir,
// used as `claude --plugin-dir $CLANKER_PATH`) and CLANKER_OPENCODE (the opencode
// plugin file).
const INTEGRATIONS = resolve(import.meta.dirname, "..", "integrations");
const PLUGIN_DIR = resolve(INTEGRATIONS, "claude", "aiso");
const OPENCODE_PLUGIN = resolve(INTEGRATIONS, "opencode", "aiso", "aiso.js");

const terminals = new TerminalManager({
  url: `http://127.0.0.1:${PORT}/ingest`,
  token: INGEST_TOKEN,
  pluginDir: PLUGIN_DIR,
  opencodePlugin: OPENCODE_PLUGIN,
});

// One robot's worth of state, built from adapter events rather than /proc.
type Agent = {
  id: string;
  terminal: string;
  kind: "agent" | "subagent";
  parent: string | null;
  tool: string;
  label: string;
  activity: FileActivity | null;
  activityTs: number;
  recent: string[];
};
const agents = new Map<string, Agent>();

function pushRecent(a: Agent, line: string): void {
  a.recent.unshift(line);
  if (a.recent.length > 12) a.recent.length = 12;
}

function subId(session: string, agentId: unknown): string {
  return `${session}:sub:${agentId ?? "anon"}`;
}

function ensureAgent(session: string, tool: string): Agent {
  let a = agents.get(session);
  if (!a) {
    a = {
      id: session,
      terminal: session,
      kind: "agent",
      parent: null,
      tool,
      label: tool,
      activity: null,
      activityTs: 0,
      recent: [],
    };
    agents.set(session, a);
  }
  return a;
}

function ensureSubagent(
  session: string,
  agentId: unknown,
  tool: string,
  label: string,
): Agent {
  const id = subId(session, agentId);
  let a = agents.get(id);
  if (!a) {
    a = {
      id,
      terminal: session,
      kind: "subagent",
      parent: session,
      tool,
      label,
      activity: null,
      activityTs: 0,
      recent: [],
    };
    agents.set(id, a);
  }
  return a;
}

function removeSession(session: string): void {
  for (const [id, a] of agents) {
    if (a.terminal === session) agents.delete(id);
  }
}

function touchWorkDir(dir: string, now: number): void {
  if (!workDirLastActive.has(dir)) worldDirty = true;
  workDirLastActive.set(dir, now);
}

function recordFile(
  dir: string,
  path: string,
  direction: "read" | "write",
  now: number,
): void {
  let m = filesByDir.get(dir);
  if (!m) {
    m = new Map();
    filesByDir.set(dir, m);
  }
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    /* gone or unreadable */
  }
  m.set(path, { path, name: basename(path), size, direction, ts: now });
  if (m.size > FILES_PER_DIR) {
    const oldest = [...m.values()].sort((a, b) => a.ts - b.ts)[0];
    if (oldest) m.delete(oldest.path);
  }
}

function isTrackedFile(path: string): boolean {
  for (const m of filesByDir.values()) if (m.has(path)) return true;
  return false;
}

// Normalize a Claude Code hook payload into agent/world state. The terminal
// island id arrives out of band in the X-Clanker-Session header.
type ClaudeHook = {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: { file_path?: unknown; command?: unknown };
  agent_id?: unknown;
  agent_type?: unknown;
  cwd?: unknown;
};

function ingest(session: string, tool: string, body: ClaudeHook): void {
  const now = Date.now();
  switch (body.hook_event_name) {
    case "SessionStart":
      ensureAgent(session, tool);
      return;
    case "SessionEnd":
    case "Stop":
      removeSession(session);
      worldDirty = true;
      return;
    case "SubagentStart": {
      ensureSubagent(
        session,
        body.agent_id,
        tool,
        typeof body.agent_type === "string" ? body.agent_type : "subagent",
      );
      return;
    }
    case "SubagentStop":
      agents.delete(subId(session, body.agent_id));
      return;
    case "PreToolUse":
    case "PostToolUse": {
      const agent = body.agent_id
        ? ensureSubagent(session, body.agent_id, tool, "subagent")
        : ensureAgent(session, tool);
      const post = body.hook_event_name === "PostToolUse";
      const file = body.tool_input?.file_path;
      if (typeof file === "string" && file.startsWith("/")) {
        const direction = body.tool_name === "Read" ? "read" : "write";
        const dir = dirname(file);
        agent.activity = { path: file, dir, direction };
        agent.activityTs = now;
        touchWorkDir(dir, now);
        recordFile(dir, file, direction, now);
        if (post) {
          pushRecent(agent, `${direction === "read" ? "read" : "edit"} ${basename(file)}`);
        }
      } else if (body.tool_name === "Bash") {
        // Bash has no file; show the robot working in the shell's cwd.
        const cwd = typeof body.cwd === "string" ? body.cwd : "";
        if (cwd.startsWith("/")) {
          agent.activity = { path: cwd, dir: cwd, direction: "run" };
          agent.activityTs = now;
          touchWorkDir(cwd, now);
          if (post) {
            const cmd =
              typeof body.tool_input?.command === "string"
                ? body.tool_input.command.replace(/\s+/g, " ").slice(0, 60)
                : "";
            pushRecent(agent, `run: ${cmd}`);
          }
        }
      }
      return;
    }
    default:
      return;
  }
}

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

function agentSnapshots(): AgentSnapshot[] {
  return [...agents.values()].map((a) => ({
    id: a.id,
    terminal: a.terminal,
    kind: a.kind,
    parent: a.parent,
    tool: a.tool,
    label: a.label,
    activity: a.activity,
    recent: a.recent,
  }));
}

function broadcast(message: string): void {
  for (const ws of liveClients) {
    if (ws.readyState === ws.OPEN) ws.send(message);
  }
}

function broadcastAgents(): void {
  broadcast(
    JSON.stringify({
      kind: "agents",
      capturedAt: Date.now(),
      agents: agentSnapshots(),
    }),
  );
}

function filesMessage(): string {
  const files = [...filesByDir.entries()].map(([dir, m]) => ({
    dir,
    entries: [...m.values()].sort((a, b) => b.ts - a.ts),
  }));
  return JSON.stringify({ kind: "files", files });
}

function broadcastFiles(): void {
  broadcast(filesMessage());
}

async function broadcastWorld(): Promise<void> {
  const world = await buildWorldFor();
  broadcast(JSON.stringify({ kind: "world-delta", regions: world.regions }));
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const { pathname } = url;
  const method = req.method ?? "GET";

  if (pathname === "/health") {
    return sendJson(res, 200, { status: "ok" });
  }

  if (pathname === "/ingest" && method === "POST") {
    if (req.headers["authorization"] !== `Bearer ${INGEST_TOKEN}`) {
      return sendJson(res, 401, { ok: false });
    }
    const session = String(req.headers["x-clanker-session"] ?? "");
    const tool = String(req.headers["x-clanker-tool"] ?? "claude");
    let body: ClaudeHook = {};
    try {
      body = (await readBody(req)) as ClaudeHook;
    } catch {
      /* ignore malformed */
    }
    if (session) {
      ingest(session, tool, body);
      broadcastAgents();
      broadcastFiles();
    }
    // Ack immediately; hooks are synchronous and must not block the agent.
    return sendJson(res, 200, {});
  }

  if (pathname === "/file" && method === "GET") {
    const path = url.searchParams.get("path") ?? "";
    if (!isTrackedFile(path)) {
      return sendJson(res, 404, { error: "not a tracked file" });
    }
    try {
      const buf = await readFile(path);
      const truncated = buf.length > FILE_MAX_BYTES;
      return sendJson(res, 200, {
        path,
        name: basename(path),
        size: buf.length,
        content: buf.subarray(0, FILE_MAX_BYTES).toString("utf8"),
        truncated,
      });
    } catch (err) {
      return sendJson(res, 500, { error: (err as Error).message });
    }
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
    const world = await buildWorldFor();
    console.log(`[world] ${world.regions.length} islands`);
    return sendJson(res, 200, world);
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
      // Snapshot the current world to the new client so it is in sync without
      // waiting for the next change (otherwise islands appear only on reload).
      if (ws.readyState === ws.OPEN) {
        ws.send(filesMessage());
        ws.send(
          JSON.stringify({
            kind: "agents",
            capturedAt: Date.now(),
            agents: agentSnapshots(),
          }),
        );
      }
      void buildWorldFor().then((w) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ kind: "world-delta", regions: w.regions }));
        }
      });
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
  console.log(`[server] map is driven by agent events at POST /ingest`);
});

setInterval(() => {
  if (liveClients.size === 0) return;
  const now = Date.now();

  for (const [dir, last] of workDirLastActive) {
    if (now - last > WORK_DIR_TTL_MS) {
      workDirLastActive.delete(dir);
      filesByDir.delete(dir);
      releaseRegion(placements, dir);
      worldDirty = true;
    }
  }
  for (const a of agents.values()) {
    if (a.activity && now - a.activityTs > ACTIVITY_TTL_MS) a.activity = null;
  }

  const liveTerms = new Set(terminals.list());
  for (const id of liveTerms) {
    if (!knownTerminals.has(id)) {
      knownTerminals.add(id);
      worldDirty = true;
    }
  }
  for (const id of [...knownTerminals]) {
    if (!liveTerms.has(id)) {
      knownTerminals.delete(id);
      removeSession(id);
      releaseRegion(placements, id);
      worldDirty = true;
    }
  }

  if (worldDirty) {
    worldDirty = false;
    void broadcastWorld();
  }
  broadcastAgents();
  broadcastFiles();
}, TICK_MS);
