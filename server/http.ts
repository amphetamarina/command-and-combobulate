import { type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { subId } from "./agents.ts";
import type { AgentRegistry } from "./agents.ts";
import type { FileRegistry } from "./files.ts";
import type { WorkDirTracker } from "./workdirs.ts";
import type { TerminalManager } from "./terminals.ts";
import type { WorldService } from "./world-service.ts";
import type { Broadcaster } from "./live.ts";
import { parseHook, type ClaudeHook, type Ingest } from "./ingest.ts";

const FILE_MAX_BYTES = 256 * 1024;

export type HttpDeps = {
  ingestToken: string;
  agents: AgentRegistry;
  files: FileRegistry;
  workDirs: WorkDirTracker;
  terminals: TerminalManager;
  worldService: WorldService;
  live: Broadcaster;
  sessions: Ingest;
};

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

// Build the HTTP request handler over the injected services. The returned
// function resolves once it has written a response.
export function createHttpHandler(deps: HttpDeps) {
  const { ingestToken, agents, files, workDirs, terminals, worldService, live, sessions } =
    deps;

  return async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const { pathname } = url;
    const method = req.method ?? "GET";

    if (pathname === "/health") {
      return sendJson(res, 200, { status: "ok" });
    }

    if (pathname === "/ingest" && method === "POST") {
      if (req.headers["authorization"] !== `Bearer ${ingestToken}`) {
        return sendJson(res, 401, { ok: false });
      }
      const session = String(req.headers["x-clanker-session"] ?? "");
      const tool = String(req.headers["x-clanker-tool"] ?? "claude");
      let body: ClaudeHook = {};
      try {
        body = parseHook(await readBody(req)) ?? {};
      } catch {
        /* ignore malformed */
      }
      if (process.env.CLANKER_DEBUG_INGEST) {
        console.log(
          `[ingest] tool=${tool} session=${session} body=${JSON.stringify(body)}`,
        );
      }
      if (session) {
        sessions.handle(session, tool, body);
        if (process.env.CLANKER_DEBUG_INGEST) {
          const a = agents.get(session);
          const sub = body.agent_id ? agents.get(subId(session, body.agent_id)) : null;
          const target = sub ?? a;
          console.log(
            `[ingest] -> agent=${target?.identity.id ?? "(none)"} activity=${JSON.stringify(target?.live.activity ?? null)} workDirs=${workDirs.keys().length}`,
          );
        }
        live.agentsChanged();
        live.filesChanged();
      }
      // Ack immediately; hooks are synchronous and must not block the agent.
      return sendJson(res, 200, {});
    }

    if (pathname === "/file" && method === "GET") {
      const path = url.searchParams.get("path") ?? "";
      if (!files.isTracked(path)) {
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
      const world = await worldService.build();
      console.log(`[world] ${world.regions.length} islands`);
      return sendJson(res, 200, world);
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  };
}
