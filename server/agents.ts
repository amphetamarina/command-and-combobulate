import { basename, dirname } from "node:path";
import type { TranscriptActivity } from "./transcript.ts";
import type { AgentSnapshot, FileActivity } from "../shared/proc-types.ts";

const RECENT_CAP = 12;

// One robot's worth of state, built from adapter events rather than /proc.
export type Agent = {
  id: string;
  terminal: string;
  kind: "agent" | "subagent";
  parent: string | null;
  tool: string;
  label: string;
  activity: FileActivity | null;
  activityTs: number;
  recent: string[];
  contextFraction: number | null;
  lastMessage: string | null;
};

// What applyActivity resolved, returned so the caller can perform the side
// effects that live outside the agent (touching the work dir, recording the
// file). Null when the activity has no placeable, absolute directory.
export type AppliedActivity = {
  dir: string;
  filePath: string | null;
  direction: "read" | "write" | "run";
};

export function subId(session: string, agentId: unknown): string {
  return `${session}:sub:${agentId ?? "anon"}`;
}

export function toSnapshot(a: Agent): AgentSnapshot {
  return {
    id: a.id,
    terminal: a.terminal,
    kind: a.kind,
    parent: a.parent,
    tool: a.tool,
    label: a.label,
    activity: a.activity,
    recent: a.recent,
    contextFraction: a.contextFraction,
    lastMessage: a.lastMessage,
  };
}

function pushRecent(a: Agent, line: string): void {
  a.recent.unshift(line);
  if (a.recent.length > RECENT_CAP) a.recent.length = RECENT_CAP;
}

export class AgentRegistry {
  private agents = new Map<string, Agent>();

  get(id: string): Agent | undefined {
    return this.agents.get(id);
  }

  delete(id: string): void {
    this.agents.delete(id);
  }

  ensureAgent(session: string, tool: string): Agent {
    let a = this.agents.get(session);
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
        contextFraction: null,
        lastMessage: null,
      };
      this.agents.set(session, a);
    }
    return a;
  }

  ensureSubagent(
    session: string,
    agentId: unknown,
    tool: string,
    label: string,
  ): Agent {
    const id = subId(session, agentId);
    let a = this.agents.get(id);
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
        contextFraction: null,
        lastMessage: null,
      };
      this.agents.set(id, a);
    }
    return a;
  }

  removeSession(session: string): void {
    for (const [id, a] of this.agents) {
      if (a.terminal === session) this.agents.delete(id);
    }
  }

  // Apply one transcript-derived activity to an agent, mutating only the agent.
  // Returns what it resolved so the caller can perform the work-dir and file
  // side effects; null when the activity has no placeable directory.
  applyActivity(
    agent: Agent,
    act: TranscriptActivity,
    now: number,
  ): AppliedActivity | null {
    const dir = act.filePath ? dirname(act.filePath) : act.cwd;
    if (!dir || !dir.startsWith("/")) return null;

    agent.activity = {
      path: act.filePath ?? dir,
      dir,
      direction: act.direction,
      verb: act.verb,
      ok: act.ok,
    };
    agent.activityTs = now;
    // Log once, at completion (ok resolved), so the start/end pair is one entry.
    if (act.ok !== null) {
      if (act.filePath) {
        pushRecent(
          agent,
          `${act.direction === "read" ? "read" : "edit"} ${basename(act.filePath)}`,
        );
      } else if (act.command) {
        pushRecent(agent, `run: ${act.command.replace(/\s+/g, " ").slice(0, 60)}`);
      }
    }
    return { dir, filePath: act.filePath, direction: act.direction };
  }

  expireActivity(now: number, ttlMs: number): void {
    for (const a of this.agents.values()) {
      if (a.activity && now - a.activityTs > ttlMs) a.activity = null;
    }
  }

  snapshots(): AgentSnapshot[] {
    return [...this.agents.values()].map(toSnapshot);
  }
}
