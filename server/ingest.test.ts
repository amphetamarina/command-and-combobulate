import { expect, test, describe } from "bun:test";
import { Ingest, parseHook, type ClaudeHook } from "./ingest.ts";
import { AgentRegistry } from "./agents.ts";
import { FileRegistry } from "./files.ts";
import { WorkDirTracker } from "./workdirs.ts";
import { TranscriptSync } from "./transcript-sync.ts";
import { subId } from "./agents.ts";

function harness() {
  const agents = new AgentRegistry();
  const files = new FileRegistry();
  const workDirs = new WorkDirTracker();
  let dirty = 0;
  const transcripts = new TranscriptSync(agents, files, workDirs, () => {
    dirty++;
  });
  const ingest = new Ingest(agents, transcripts, () => {
    dirty++;
  });
  return { agents, transcripts, ingest, dirty: () => dirty };
}

const MAIN = "/tmp/clanker-test-main.jsonl";

describe("Ingest session lifecycle", () => {
  test("SessionStart creates a main agent", () => {
    const { agents, ingest } = harness();
    ingest.handle("t1", "claude", { hook_event_name: "SessionStart" });
    const a = agents.get("t1");
    expect(a?.identity.kind).toBe("agent");
    expect(a?.identity.tool).toBe("claude");
  });

  test("SessionEnd removes the agent and flags the world dirty", () => {
    const { agents, ingest, dirty } = harness();
    ingest.handle("t1", "claude", { hook_event_name: "SessionStart" });
    const before = dirty();
    ingest.handle("t1", "claude", { hook_event_name: "SessionEnd" });
    expect(agents.get("t1")).toBeUndefined();
    expect(dirty()).toBe(before + 1);
  });

  test("Stop also tears the session down", () => {
    const { agents, ingest } = harness();
    ingest.handle("t1", "claude", { hook_event_name: "SessionStart" });
    ingest.handle("t1", "claude", { hook_event_name: "Stop" });
    expect(agents.get("t1")).toBeUndefined();
  });

  test("SubagentStart creates a subagent and registers its transcript", () => {
    const { agents, transcripts, ingest } = harness();
    ingest.handle("t1", "claude", { hook_event_name: "SessionStart", transcript_path: MAIN });
    ingest.handle("t1", "claude", {
      hook_event_name: "SubagentStart",
      transcript_path: MAIN,
      agent_id: "abc",
      agent_type: "explorer",
    });
    const sub = agents.get(subId("t1", "abc"));
    expect(sub?.identity.kind).toBe("subagent");
    expect(sub?.identity.label).toBe("explorer");
    expect(transcripts.keys()).toContain(subId("t1", "abc"));
  });

  test("SubagentStop drains then removes the subagent and its tailer", () => {
    const { agents, transcripts, ingest } = harness();
    ingest.handle("t1", "claude", { hook_event_name: "SessionStart", transcript_path: MAIN });
    ingest.handle("t1", "claude", {
      hook_event_name: "SubagentStart",
      transcript_path: MAIN,
      agent_id: "abc",
    });
    ingest.handle("t1", "claude", {
      hook_event_name: "SubagentStop",
      transcript_path: MAIN,
      agent_id: "abc",
    });
    expect(agents.get(subId("t1", "abc"))).toBeUndefined();
    expect(transcripts.keys()).not.toContain(subId("t1", "abc"));
  });

  test("a tool-use poke on the main session ensures the agent exists", () => {
    const { agents, ingest } = harness();
    ingest.handle("t1", "claude", {
      hook_event_name: "PostToolUse",
      transcript_path: MAIN,
    });
    expect(agents.get("t1")?.identity.kind).toBe("agent");
  });

  test("an unknown hook event is a no-op", () => {
    const { agents, ingest } = harness();
    ingest.handle("t1", "claude", { hook_event_name: "Whatever" });
    expect(agents.get("t1")).toBeUndefined();
  });

  test("forgetSession is safe to call for an unknown session", () => {
    const { ingest } = harness();
    expect(() => ingest.forgetSession("nope")).not.toThrow();
  });
});

describe("parseHook", () => {
  test("rejects a payload that is not a plain object", () => {
    expect(parseHook(null)).toBeNull();
    expect(parseHook("PostToolUse")).toBeNull();
    expect(parseHook(42)).toBeNull();
    expect(parseHook(["PostToolUse"])).toBeNull();
  });

  test("keeps every well-typed field from a full payload", () => {
    const hook = parseHook({
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      agent_id: "abc",
      agent_type: "explorer",
      transcript_path: "/main.jsonl",
      agent_transcript_path: "/sub.jsonl",
      model: "claude-opus-4-8",
      cwd: "/repo",
    });
    expect(hook).toEqual({
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      agent_id: "abc",
      agent_type: "explorer",
      transcript_path: "/main.jsonl",
      agent_transcript_path: "/sub.jsonl",
      model: "claude-opus-4-8",
      cwd: "/repo",
    });
  });

  test("accepts a partial payload, keeping only the fields present", () => {
    expect(parseHook({ hook_event_name: "SessionStart" })).toEqual({
      hook_event_name: "SessionStart",
    });
    expect(parseHook({})).toEqual({});
  });

  test("drops wrong-typed fields instead of forwarding them to the domain", () => {
    expect(
      parseHook({
        hook_event_name: 123,
        transcript_path: { p: 1 },
        model: null,
        agent_id: { nested: true },
      }),
    ).toEqual({});
  });

  test("accepts a numeric agent_id but drops a structured one", () => {
    expect(parseHook({ agent_id: 7 })?.agent_id).toBe(7);
    expect(parseHook({ agent_id: ["x"] })?.agent_id).toBeUndefined();
  });
});
