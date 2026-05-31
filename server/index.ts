import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, readlink } from "node:fs/promises";
import { statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { buildWorld, releaseRegion, type TerminalInfo } from "./world-builder.ts";
import { classifyFile } from "./classify.ts";
import { TranscriptTailer, type TranscriptActivity } from "./transcript.ts";
import { loadCache, saveCache } from "./persistence.ts";
import { TerminalManager, type TermClient } from "./terminals.ts";
import { AgentRegistry, subId, type Agent } from "./agents.ts";
import type { World } from "../shared/types.ts";
import type { FileEntry } from "../shared/proc-types.ts";

// The hook payload an adapter POSTs to /ingest, shaped like a Claude Code hook
// event. Each adapter normalises its own format into this before sending.
type ClaudeHook = {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: { file_path?: unknown; command?: unknown };
  tool_response?: unknown;
  transcript_path?: unknown;
  agent_transcript_path?: unknown;
  model?: unknown;
  agent_id?: unknown;
  agent_type?: unknown;
  cwd?: unknown;
};

const PORT = Number(process.env.TTY_API_PORT ?? 3001);
const TICK_MS = 1000;
const WORK_DIR_TTL_MS = 600000;
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
// Agent activity is read from each session's Claude transcript, not from hook
// tool payloads (which omit the exit status). The hook only tells us the path
// and pokes us to read. One tailer per session, keyed by terminal id.
const tailers = new Map<string, { path: string; tailer: TranscriptTailer }>();
const sessionTool = new Map<string, string>();
const sessionModel = new Map<string, string>();
let worldDirty = false;

// Absolute path to the Claude plugin dir, injected as CLANKER_PATH and used as
// `claude --plugin-dir $CLANKER_PATH`.
const INTEGRATIONS = resolve(import.meta.dirname, "..", "integrations");
const PLUGIN_DIR = resolve(INTEGRATIONS, "claude", "clanker");

const terminals = new TerminalManager({
  url: `http://127.0.0.1:${PORT}/ingest`,
  token: INGEST_TOKEN,
  pluginDir: PLUGIN_DIR,
});

const agents = new AgentRegistry();

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
  m.set(path, {
    path,
    name: basename(path),
    size,
    direction,
    role: classifyFile(path),
    ts: now,
  });
  if (m.size > FILES_PER_DIR) {
    const oldest = [...m.values()].sort((a, b) => a.ts - b.ts)[0];
    if (oldest) m.delete(oldest.path);
  }
}

function isTrackedFile(path: string): boolean {
  for (const m of filesByDir.values()) if (m.has(path)) return true;
  return false;
}


function registerTranscript(key: string, path: unknown): void {
  if (typeof path !== "string" || !path) return;
  const existing = tailers.get(key);
  if (existing && existing.path === path) return;
  tailers.set(key, { path, tailer: new TranscriptTailer(path) });
}

// A subagent's transcript lives beside the main one, under <session>/subagents.
// Prefer the path the hook hands us; otherwise derive it from the main path.
function subagentTranscriptPath(body: ClaudeHook): string | null {
  if (typeof body.agent_transcript_path === "string") return body.agent_transcript_path;
  const main = body.transcript_path;
  if (typeof main !== "string" || !main.endsWith(".jsonl") || !body.agent_id) return null;
  return `${main.slice(0, -".jsonl".length)}/subagents/agent-${String(body.agent_id)}.jsonl`;
}

// Apply one transcript-derived activity: the registry mutates the agent, and we
// perform the side effects it resolves -- drive the work dir and record the file.
function applyActivity(agent: Agent, act: TranscriptActivity, now: number): void {
  const applied = agents.applyActivity(agent, act, now);
  if (!applied) return;
  touchWorkDir(applied.dir, now);
  if (applied.filePath && applied.direction !== "run") {
    recordFile(
      applied.dir,
      applied.filePath,
      applied.direction === "read" ? "read" : "write",
      now,
    );
  }
}

// The agent's context window in tokens, inferred from the model id (e.g.
// "claude-opus-4-8[1m]" carries a 1M window); a conservative default otherwise.
function contextWindowFor(model: string | undefined): number {
  if (model && /\[1m\]/i.test(model)) return 1_000_000;
  return 200_000;
}

// Drain one agent's transcript tailer (main session or subagent), applying any
// newly appended activity and refreshing its context fill and last message.
function pumpTranscript(agentId: string): void {
  const entry = tailers.get(agentId);
  const agent = agents.get(agentId);
  if (!entry || !agent) return;
  const now = Date.now();
  for (const act of entry.tailer.readNew()) applyActivity(agent, act, now);

  // Context fill drives the base brownout, which is the main agent's terminal.
  if (agent.kind === "agent" && entry.tailer.contextTokens !== null) {
    agent.contextFraction = Math.min(
      1,
      entry.tailer.contextTokens / contextWindowFor(sessionModel.get(agent.terminal)),
    );
  }
  if (entry.tailer.lastMessage !== null) agent.lastMessage = entry.tailer.lastMessage;
}

function ingest(session: string, tool: string, body: ClaudeHook): void {
  sessionTool.set(session, tool);
  if (typeof body.model === "string") sessionModel.set(session, body.model);
  registerTranscript(session, body.transcript_path);
  switch (body.hook_event_name) {
    case "SessionStart":
      agents.ensureAgent(session, tool);
      return;
    case "SessionEnd":
    case "Stop":
      agents.removeSession(session);
      for (const key of [...tailers.keys()]) {
        if (key === session || key.startsWith(`${session}:sub:`)) tailers.delete(key);
      }
      sessionTool.delete(session);
      sessionModel.delete(session);
      worldDirty = true;
      return;
    case "SubagentStart": {
      agents.ensureSubagent(
        session,
        body.agent_id,
        tool,
        typeof body.agent_type === "string" ? body.agent_type : "subagent",
      );
      // Tail the subagent's own transcript so its tool calls show on the map.
      registerTranscript(subId(session, body.agent_id), subagentTranscriptPath(body));
      return;
    }
    case "SubagentStop": {
      const id = subId(session, body.agent_id);
      pumpTranscript(id);
      agents.delete(id);
      tailers.delete(id);
      return;
    }
    case "PreToolUse":
    case "PostToolUse":
      // The activity itself comes from the transcript, not this payload; the
      // hook is only a poke to read whatever lines have just landed. Pump the
      // subagent's transcript when the call came from one, else the main agent.
      if (body.agent_id) {
        pumpTranscript(subId(session, body.agent_id));
      } else {
        agents.ensureAgent(session, tool);
        pumpTranscript(session);
      }
      return;
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
      agents: agents.snapshots(),
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
      const raw = (await readBody(req)) as Record<string, unknown>;
      body = raw as unknown as ClaudeHook;
    } catch {
      /* ignore malformed */
    }
    if (process.env.CLANKER_DEBUG_INGEST) {
      console.log(
        `[ingest] tool=${tool} session=${session} body=${JSON.stringify(body)}`,
      );
    }
    if (session) {
      ingest(session, tool, body);
      if (process.env.CLANKER_DEBUG_INGEST) {
        const a = agents.get(session);
        const sub = body.agent_id ? agents.get(subId(session, body.agent_id)) : null;
        const target = sub ?? a;
        console.log(
          `[ingest] -> agent=${target?.id ?? "(none)"} activity=${JSON.stringify(target?.activity ?? null)} workDirs=${workDirLastActive.size}`,
        );
      }
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

  if (pathname === "/agent/freeze" && method === "POST") {
    const { terminal } = (await readBody(req)) as { terminal?: unknown };
    terminals.freeze(String(terminal));
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === "/agent/unfreeze" && method === "POST") {
    const { terminal } = (await readBody(req)) as { terminal?: unknown };
    terminals.unfreeze(String(terminal));
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === "/agent/interrupt" && method === "POST") {
    const { terminal } = (await readBody(req)) as { terminal?: unknown };
    terminals.interrupt(String(terminal));
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === "/agent/ask" && method === "POST") {
    const { terminal, text } = (await readBody(req)) as {
      terminal?: unknown;
      text?: unknown;
    };
    // Append a carriage return so the injected message submits in the agent's TUI.
    terminals.ask(String(terminal), `${String(text)}\r`);
    return sendJson(res, 200, { ok: true });
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
            agents: agents.snapshots(),
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
  if (url.pathname === "/termview") {
    // Like /term, but serves the emulator's resolved screen grid (JSON frames)
    // instead of raw PTY bytes, for clients that cannot run a VT parser.
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
      term.attachView(client);
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
      ws.on("close", () => term.detachView(client));
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

  // Pull any transcript activity that landed since the last tick (e.g. a
  // tool_result that arrived just after its PostToolUse hook poked us).
  for (const session of tailers.keys()) pumpTranscript(session);

  for (const [dir, last] of workDirLastActive) {
    if (now - last > WORK_DIR_TTL_MS) {
      workDirLastActive.delete(dir);
      filesByDir.delete(dir);
      releaseRegion(placements, dir);
      worldDirty = true;
    }
  }
  agents.expireActivity(now, ACTIVITY_TTL_MS);

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
      for (const key of [...tailers.keys()]) {
        if (key === id || key.startsWith(`${id}:sub:`)) tailers.delete(key);
      }
      sessionTool.delete(id);
      sessionModel.delete(id);
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
