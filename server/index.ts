import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { loadCache } from "./persistence.ts";
import { TerminalManager } from "./terminals.ts";
import { AgentRegistry } from "./agents.ts";
import { FileRegistry } from "./files.ts";
import { WorkDirTracker } from "./workdirs.ts";
import { TranscriptSync } from "./transcript-sync.ts";
import { Ingest } from "./ingest.ts";
import { WorldService } from "./world-service.ts";
import { Broadcaster } from "./live.ts";
import { createHttpHandler } from "./http.ts";
import { attachWsRoutes } from "./ws.ts";

const PORT = Number(process.env.TTY_API_PORT ?? 3001);
const TICK_MS = 1000;
const ACTIVITY_TTL_MS = 6000;
const CACHE_PATH =
  process.env.CLANKER_CACHE ?? join(process.cwd(), ".clanker-cache.json");
const INGEST_TOKEN = process.env.CLANKER_TOKEN ?? randomUUID();

// Absolute path to the Claude plugin dir, injected as CLANKER_PATH and used as
// `claude --plugin-dir $CLANKER_PATH`.
const INTEGRATIONS = resolve(import.meta.dirname, "..", "integrations");
const PLUGIN_DIR = resolve(INTEGRATIONS, "claude", "clanker");

const placements = await loadCache(CACHE_PATH);
const knownTerminals = new Set<string>();
let worldDirty = false;
const markWorldDirty = () => {
  worldDirty = true;
};

const terminals = new TerminalManager({
  url: `http://127.0.0.1:${PORT}/ingest`,
  token: INGEST_TOKEN,
  pluginDir: PLUGIN_DIR,
});
const agents = new AgentRegistry();
const files = new FileRegistry();
const workDirs = new WorkDirTracker();
const transcripts = new TranscriptSync(agents, files, workDirs, markWorldDirty);
const sessions = new Ingest(agents, transcripts, markWorldDirty);
const worldService = new WorldService(terminals, workDirs, placements, CACHE_PATH);
const live = new Broadcaster(agents, files, worldService);

const handle = createHttpHandler({
  ingestToken: INGEST_TOKEN,
  agents,
  files,
  workDirs,
  terminals,
  worldService,
  live,
  sessions,
});

const httpServer = createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.warn(`[http] ${(err as Error).message}`);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "internal" }));
    }
  });
});

attachWsRoutes(httpServer, { terminals, live });

httpServer.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
  console.log(`[server] map is driven by agent events at POST /ingest`);
});

setInterval(() => {
  if (live.size === 0) return;
  const now = Date.now();

  // Pull any transcript activity that landed since the last tick (e.g. a
  // tool_result that arrived just after its PostToolUse hook poked us).
  for (const session of transcripts.keys()) transcripts.pump(session);

  for (const dir of workDirs.evictIdle(now)) {
    files.forget(dir);
    worldService.release(dir);
    worldDirty = true;
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
      agents.removeSession(id);
      transcripts.removeForSession(id);
      sessions.forgetSession(id);
      worldService.release(id);
      worldDirty = true;
    }
  }

  if (worldDirty) {
    worldDirty = false;
    void live.worldChanged();
  }
  live.agentsChanged();
  live.filesChanged();
}, TICK_MS);
