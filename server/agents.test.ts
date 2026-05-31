import { expect, test, describe } from "bun:test";
import { AgentRegistry, subId, toSnapshot, type Agent } from "./agents.ts";
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
    ok: true,
    ts: 1000,
    isSidechain: false,
    ...over,
  };
}

describe("subId", () => {
  test("composes a stable subagent id", () => {
    expect(subId("t1", "abc")).toBe("t1:sub:abc");
  });

  test("falls back to anon when the agent id is missing", () => {
    expect(subId("t1", undefined)).toBe("t1:sub:anon");
    expect(subId("t1", null)).toBe("t1:sub:anon");
  });
});

describe("ensureAgent", () => {
  test("creates a main agent with sane defaults", () => {
    const reg = new AgentRegistry();
    const a = reg.ensureAgent("t1", "claude");
    expect(a.id).toBe("t1");
    expect(a.terminal).toBe("t1");
    expect(a.kind).toBe("agent");
    expect(a.parent).toBeNull();
    expect(a.tool).toBe("claude");
    expect(a.label).toBe("claude");
    expect(a.activity).toBeNull();
    expect(a.recent).toEqual([]);
    expect(a.contextFraction).toBeNull();
    expect(a.lastMessage).toBeNull();
  });

  test("is idempotent and returns the same instance", () => {
    const reg = new AgentRegistry();
    const first = reg.ensureAgent("t1", "claude");
    const second = reg.ensureAgent("t1", "codex");
    expect(second).toBe(first);
    expect(second.tool).toBe("claude");
  });
});

describe("ensureSubagent", () => {
  test("creates a subagent parented to the session", () => {
    const reg = new AgentRegistry();
    const sub = reg.ensureSubagent("t1", "abc", "claude", "explorer");
    expect(sub.id).toBe("t1:sub:abc");
    expect(sub.terminal).toBe("t1");
    expect(sub.kind).toBe("subagent");
    expect(sub.parent).toBe("t1");
    expect(sub.label).toBe("explorer");
  });

  test("is idempotent", () => {
    const reg = new AgentRegistry();
    const first = reg.ensureSubagent("t1", "abc", "claude", "explorer");
    const second = reg.ensureSubagent("t1", "abc", "claude", "other");
    expect(second).toBe(first);
    expect(second.label).toBe("explorer");
  });
});

describe("removeSession", () => {
  test("drops the agent and all of its subagents", () => {
    const reg = new AgentRegistry();
    reg.ensureAgent("t1", "claude");
    reg.ensureSubagent("t1", "a", "claude", "x");
    reg.ensureSubagent("t1", "b", "claude", "y");
    reg.ensureAgent("t2", "claude");

    reg.removeSession("t1");

    expect(reg.get("t1")).toBeUndefined();
    expect(reg.get("t1:sub:a")).toBeUndefined();
    expect(reg.get("t1:sub:b")).toBeUndefined();
    expect(reg.get("t2")).toBeDefined();
  });
});

describe("applyActivity", () => {
  test("sets the agent's activity and returns what it resolved", () => {
    const reg = new AgentRegistry();
    const a = reg.ensureAgent("t1", "claude");
    const applied = reg.applyActivity(a, activity(), 5000);

    expect(applied).toEqual({
      dir: "/repo/src",
      filePath: "/repo/src/index.ts",
      direction: "read",
    });
    expect(a.activity).toEqual({
      path: "/repo/src/index.ts",
      dir: "/repo/src",
      direction: "read",
      verb: "read",
      ok: true,
    });
    expect(a.activityTs).toBe(5000);
  });

  test("uses cwd when there is no file path", () => {
    const reg = new AgentRegistry();
    const a = reg.ensureAgent("t1", "claude");
    const applied = reg.applyActivity(
      a,
      activity({ filePath: null, command: "ls -la", verb: "run", direction: "run" }),
      5000,
    );
    expect(applied).toEqual({ dir: "/repo", filePath: null, direction: "run" });
    expect(a.activity?.path).toBe("/repo");
    expect(a.activity?.dir).toBe("/repo");
  });

  test("returns null and does not mutate for a non-absolute dir", () => {
    const reg = new AgentRegistry();
    const a = reg.ensureAgent("t1", "claude");
    const applied = reg.applyActivity(
      a,
      activity({ filePath: null, cwd: "relative/path" }),
      5000,
    );
    expect(applied).toBeNull();
    expect(a.activity).toBeNull();
  });

  test("logs a recent file action only once the outcome is known", () => {
    const reg = new AgentRegistry();
    const a = reg.ensureAgent("t1", "claude");

    reg.applyActivity(a, activity({ ok: null }), 5000);
    expect(a.recent).toEqual([]);

    reg.applyActivity(a, activity({ ok: true }), 5001);
    expect(a.recent).toEqual(["read index.ts"]);
  });

  test("logs an edit for a write and a run for a command", () => {
    const reg = new AgentRegistry();
    const a = reg.ensureAgent("t1", "claude");

    reg.applyActivity(
      a,
      activity({ filePath: "/repo/src/a.ts", direction: "write", verb: "edit", ok: true }),
      1,
    );
    reg.applyActivity(
      a,
      activity({ filePath: null, command: "bun test", direction: "run", verb: "run", ok: true }),
      2,
    );

    expect(a.recent[0]).toBe("run: bun test");
    expect(a.recent[1]).toBe("edit a.ts");
  });

  test("caps the recent log at 12 entries, newest first", () => {
    const reg = new AgentRegistry();
    const a = reg.ensureAgent("t1", "claude");
    for (let i = 0; i < 20; i++) {
      reg.applyActivity(
        a,
        activity({ filePath: `/repo/f${i}.ts`, direction: "read", ok: true }),
        i,
      );
    }
    expect(a.recent.length).toBe(12);
    expect(a.recent[0]).toBe("read f19.ts");
  });
});

describe("expireActivity", () => {
  test("clears activity older than the ttl, keeps fresh ones", () => {
    const reg = new AgentRegistry();
    const stale = reg.ensureAgent("t1", "claude");
    const fresh = reg.ensureAgent("t2", "claude");
    reg.applyActivity(stale, activity({ ok: true }), 1000);
    reg.applyActivity(fresh, activity({ ok: true }), 9000);

    reg.expireActivity(10000, 6000);

    expect(stale.activity).toBeNull();
    expect(fresh.activity).not.toBeNull();
  });
});

describe("snapshots", () => {
  test("projects every agent to the wire shape", () => {
    const reg = new AgentRegistry();
    reg.ensureAgent("t1", "claude");
    reg.ensureSubagent("t1", "a", "claude", "explorer");

    const snaps = reg.snapshots();
    expect(snaps.length).toBe(2);
    const main = snaps.find((s) => s.id === "t1");
    expect(main).toEqual({
      id: "t1",
      terminal: "t1",
      kind: "agent",
      parent: null,
      tool: "claude",
      label: "claude",
      activity: null,
      recent: [],
      contextFraction: null,
      lastMessage: null,
    });
  });

  test("toSnapshot copies a single agent's fields", () => {
    const a: Agent = {
      id: "t1",
      terminal: "t1",
      kind: "agent",
      parent: null,
      tool: "claude",
      label: "claude",
      activity: null,
      activityTs: 0,
      recent: ["read x.ts"],
      contextFraction: 0.5,
      lastMessage: "hi",
    };
    const snap = toSnapshot(a);
    expect(snap.contextFraction).toBe(0.5);
    expect(snap.lastMessage).toBe("hi");
    expect(snap.recent).toEqual(["read x.ts"]);
    expect(snap).not.toHaveProperty("activityTs");
  });
});
