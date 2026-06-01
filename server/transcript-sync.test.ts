import { expect, test, describe } from "bun:test";
import {
  TranscriptSync,
  contextWindowFor,
  subagentTranscriptPath,
  type Tailer,
} from "./transcript-sync.ts";
import { AgentRegistry } from "./agents.ts";
import { FileRegistry } from "./files.ts";
import { WorkDirTracker } from "./workdirs.ts";
import type { TranscriptActivity } from "./transcript.ts";

function activity(over: Partial<TranscriptActivity> = {}): TranscriptActivity {
  return {
    toolUseId: "u1",
    tool: "Read",
    filePath: "/repo/src/index.ts",
    command: null,
    cwd: "/repo",
    verb: "read",
    direction: "read",
    outcome: "ok",
    ts: 1000,
    isSidechain: false,
    ...over,
  };
}

class FakeTailer implements Tailer {
  contextTokens: number | null = null;
  lastMessage: string | null = null;
  private batches: TranscriptActivity[][];
  constructor(batches: TranscriptActivity[][] = []) {
    this.batches = batches;
  }
  readNew(): TranscriptActivity[] {
    return this.batches.shift() ?? [];
  }
}

function harness(tailer: Tailer) {
  const agents = new AgentRegistry();
  const files = new FileRegistry();
  const workDirs = new WorkDirTracker();
  let dirtyCount = 0;
  const sync = new TranscriptSync(
    agents,
    files,
    workDirs,
    () => {
      dirtyCount++;
    },
    () => tailer,
  );
  return { agents, files, workDirs, sync, dirty: () => dirtyCount };
}

describe("contextWindowFor", () => {
  test("reads a 1M window from a [1m] model id", () => {
    expect(contextWindowFor("claude-opus-4-8[1m]")).toBe(1_000_000);
  });
  test("defaults to 200k otherwise", () => {
    expect(contextWindowFor("claude-opus-4-8")).toBe(200_000);
    expect(contextWindowFor(undefined)).toBe(200_000);
  });
});

describe("subagentTranscriptPath", () => {
  test("prefers an explicit agent transcript path", () => {
    expect(subagentTranscriptPath("/explicit.jsonl", "/main.jsonl", "a")).toBe(
      "/explicit.jsonl",
    );
  });
  test("derives the path from the main transcript when not explicit", () => {
    expect(subagentTranscriptPath(undefined, "/x/main.jsonl", "abc")).toBe(
      "/x/main/subagents/agent-abc.jsonl",
    );
  });
  test("returns null without a usable main path or agent id", () => {
    expect(subagentTranscriptPath(undefined, "/x/main.txt", "abc")).toBeNull();
    expect(subagentTranscriptPath(undefined, "/x/main.jsonl", undefined)).toBeNull();
  });
});

describe("TranscriptSync.pump", () => {
  test("fans a file activity out to all three registries", () => {
    const { agents, files, workDirs, sync, dirty } = harness(
      new FakeTailer([[activity()]]),
    );
    agents.ensureAgent("t1", "claude");
    sync.register("t1", "/main.jsonl");

    sync.pump("t1");

    expect(agents.get("t1")?.live.activity?.path).toBe("/repo/src/index.ts");
    expect(files.isTracked("/repo/src/index.ts")).toBe(true);
    expect(workDirs.keys()).toContain("/repo/src");
    expect(dirty()).toBe(1);
  });

  test("does nothing for an unregistered or unknown agent", () => {
    const { sync } = harness(new FakeTailer([[activity()]]));
    sync.pump("nobody"); // no tailer, no agent -> no throw
    expect(true).toBe(true);
  });

  test("derives contextFraction for a main agent from the model window", () => {
    const tailer = new FakeTailer([[]]);
    tailer.contextTokens = 100_000;
    const { agents, sync } = harness(tailer);
    agents.ensureAgent("t1", "claude");
    sync.setModel("t1", "claude-opus-4-8"); // 200k window
    sync.register("t1", "/main.jsonl");

    sync.pump("t1");

    expect(agents.get("t1")?.live.contextFraction).toBeCloseTo(0.5, 5);
  });

  test("records the agent's last message", () => {
    const tailer = new FakeTailer([[]]);
    tailer.lastMessage = "working on it";
    const { agents, sync } = harness(tailer);
    agents.ensureAgent("t1", "claude");
    sync.register("t1", "/main.jsonl");

    sync.pump("t1");

    expect(agents.get("t1")?.live.lastMessage).toBe("working on it");
  });
});

describe("TranscriptSync registration", () => {
  test("register is idempotent for the same path", () => {
    let made = 0;
    const agents = new AgentRegistry();
    const sync = new TranscriptSync(
      agents,
      new FileRegistry(),
      new WorkDirTracker(),
      () => {},
      () => {
        made++;
        return new FakeTailer();
      },
    );
    sync.register("t1", "/main.jsonl");
    sync.register("t1", "/main.jsonl");
    expect(made).toBe(1);
    expect(sync.keys()).toEqual(["t1"]);
  });

  test("ignores a non-string path", () => {
    const { sync } = harness(new FakeTailer());
    sync.register("t1", undefined);
    sync.register("t1", "");
    expect(sync.keys()).toEqual([]);
  });

  test("removeForSession drops the session and its subagent tailers", () => {
    const { sync } = harness(new FakeTailer());
    sync.register("t1", "/m.jsonl");
    sync.register("t1:sub:a", "/s.jsonl");
    sync.register("t2", "/o.jsonl");

    sync.removeForSession("t1");

    expect(sync.keys().sort()).toEqual(["t2"]);
  });

  test("delete drops a single tailer", () => {
    const { sync } = harness(new FakeTailer());
    sync.register("t1:sub:a", "/s.jsonl");
    sync.delete("t1:sub:a");
    expect(sync.keys()).toEqual([]);
  });
});
