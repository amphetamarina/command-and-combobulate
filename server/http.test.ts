import { expect, test, describe } from "bun:test";
import { Readable } from "node:stream";
import { createHttpHandler, type HttpDeps } from "./http.ts";
import { AgentRegistry } from "./agents.ts";
import { FileRegistry } from "./files.ts";
import { WorkDirTracker } from "./workdirs.ts";
import { TranscriptSync } from "./transcript-sync.ts";
import { Ingest } from "./ingest.ts";
import { WorldService } from "./world-service.ts";
import { Broadcaster } from "./live.ts";
import { emptyCache } from "./world-builder.ts";
import type { TerminalManager } from "./terminals.ts";

const TOKEN = "secret";

type Captured = { status: number; headers: Record<string, string>; body: string };

// A minimal ServerResponse stand-in capturing the written status and body.
function fakeRes(): { res: any; captured: Captured } {
  const captured: Captured = { status: 0, headers: {}, body: "" };
  const res = {
    headersSent: false,
    writeHead(status: number, headers: Record<string, string>) {
      captured.status = status;
      captured.headers = headers;
      this.headersSent = true;
    },
    end(body?: string) {
      captured.body = body ?? "";
    },
  };
  return { res, captured };
}

function fakeReq(method: string, url: string, opts: { headers?: Record<string, string>; body?: string } = {}) {
  const stream = Readable.from(opts.body ? [Buffer.from(opts.body)] : []) as any;
  stream.method = method;
  stream.url = url;
  stream.headers = opts.headers ?? {};
  return stream;
}

function harness(terminals?: Partial<TerminalManager>): HttpDeps {
  const agents = new AgentRegistry();
  const files = new FileRegistry();
  const workDirs = new WorkDirTracker();
  const transcripts = new TranscriptSync(agents, files, workDirs, () => {});
  const term = (terminals ?? {}) as TerminalManager;
  const worldService = new WorldService(
    { refs: () => [] } as unknown as TerminalManager,
    workDirs,
    emptyCache(),
    "/tmp/clanker-http-test-cache.json",
  );
  return {
    ingestToken: TOKEN,
    agents,
    files,
    workDirs,
    terminals: term,
    worldService,
    live: new Broadcaster(agents, files, worldService),
    sessions: new Ingest(agents, transcripts, () => {}),
  };
}

describe("http /health", () => {
  test("returns ok", async () => {
    const handle = createHttpHandler(harness());
    const { res, captured } = fakeRes();
    await handle(fakeReq("GET", "/health"), res);
    expect(captured.status).toBe(200);
    expect(JSON.parse(captured.body).status).toBe("ok");
  });
});

describe("http /ingest auth", () => {
  test("rejects a missing/invalid token with 401", async () => {
    const handle = createHttpHandler(harness());
    const { res, captured } = fakeRes();
    await handle(fakeReq("POST", "/ingest", { headers: {} }), res);
    expect(captured.status).toBe(401);
  });

  test("accepts a valid token and creates the agent", async () => {
    const deps = harness();
    const handle = createHttpHandler(deps);
    const { res, captured } = fakeRes();
    await handle(
      fakeReq("POST", "/ingest", {
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "x-clanker-session": "t1",
          "x-clanker-tool": "claude",
        },
        body: JSON.stringify({ hook_event_name: "SessionStart" }),
      }),
      res,
    );
    expect(captured.status).toBe(200);
    expect(deps.agents.get("t1")?.identity.kind).toBe("agent");
  });
});

describe("http /file", () => {
  test("404s for an untracked path", async () => {
    const handle = createHttpHandler(harness());
    const { res, captured } = fakeRes();
    await handle(fakeReq("GET", "/file?path=/etc/passwd"), res);
    expect(captured.status).toBe(404);
  });
});

describe("http /term/new", () => {
  test("creates a terminal and returns its id", async () => {
    let created = false;
    const deps = harness({
      create: () => {
        created = true;
        return "t7";
      },
    } as Partial<TerminalManager>);
    const handle = createHttpHandler(deps);
    const { res, captured } = fakeRes();
    await handle(fakeReq("POST", "/term/new", { body: "{}" }), res);
    expect(created).toBe(true);
    expect(JSON.parse(captured.body).id).toBe("t7");
  });
});

describe("http unknown route", () => {
  test("404s", async () => {
    const handle = createHttpHandler(harness());
    const { res, captured } = fakeRes();
    await handle(fakeReq("GET", "/nope"), res);
    expect(captured.status).toBe(404);
  });
});
