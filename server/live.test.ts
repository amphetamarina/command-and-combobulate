import { expect, test, describe } from "bun:test";
import { Broadcaster, type LiveClient } from "./live.ts";
import { AgentRegistry } from "./agents.ts";
import { FileRegistry } from "./files.ts";
import { WorldService } from "./world-service.ts";
import { WorkDirTracker } from "./workdirs.ts";
import { emptyCache } from "./world-builder.ts";
import type { TerminalManager } from "./terminals.ts";

const OPEN = 1;
const CLOSED = 3;

class FakeClient implements LiveClient {
  readonly OPEN = OPEN;
  sent: string[] = [];
  constructor(public readyState: number = OPEN) {}
  send(data: string): void {
    this.sent.push(data);
  }
}

function harness() {
  const agents = new AgentRegistry();
  const files = new FileRegistry();
  const worldService = new WorldService(
    { refs: () => [] } as unknown as TerminalManager,
    new WorkDirTracker(),
    emptyCache(),
    "/tmp/combobulate-live-test-cache.json",
  );
  return { agents, files, broadcaster: new Broadcaster(agents, files, worldService) };
}

describe("Broadcaster membership", () => {
  test("tracks size as clients join and leave", () => {
    const { broadcaster } = harness();
    const a = new FakeClient();
    const b = new FakeClient();
    expect(broadcaster.size).toBe(0);
    broadcaster.add(a);
    broadcaster.add(b);
    expect(broadcaster.size).toBe(2);
    broadcaster.remove(a);
    expect(broadcaster.size).toBe(1);
  });
});

describe("Broadcaster delivery", () => {
  test("agentsChanged sends an agents message to open clients", () => {
    const { agents, broadcaster } = harness();
    agents.ensureAgent("t1", "claude");
    const c = new FakeClient();
    broadcaster.add(c);
    broadcaster.agentsChanged();
    expect(c.sent.length).toBe(1);
    const msg = JSON.parse(c.sent[0]!);
    expect(msg.kind).toBe("agents");
    expect(msg.agents.length).toBe(1);
  });

  test("filesChanged sends a files message", () => {
    const { files, broadcaster } = harness();
    files.record("/repo", "/repo/a.ts", "read", 1);
    const c = new FakeClient();
    broadcaster.add(c);
    broadcaster.filesChanged();
    expect(JSON.parse(c.sent[0]!).kind).toBe("files");
  });

  test("does not send to a non-open client", () => {
    const { broadcaster } = harness();
    const closed = new FakeClient(CLOSED);
    broadcaster.add(closed);
    broadcaster.agentsChanged();
    expect(closed.sent.length).toBe(0);
  });
});

describe("Broadcaster snapshot", () => {
  test("snapshotTo sends files and agents synchronously", () => {
    const { broadcaster } = harness();
    const c = new FakeClient();
    broadcaster.snapshotTo(c);
    const kinds = c.sent.map((s) => JSON.parse(s).kind);
    expect(kinds).toContain("files");
    expect(kinds).toContain("agents");
  });
});
