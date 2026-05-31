import { TranscriptTailer, type TranscriptActivity } from "./transcript.ts";
import type { AgentRegistry, Agent } from "./agents.ts";
import type { FileRegistry } from "./files.ts";
import type { WorkDirTracker } from "./workdirs.ts";

// The slice of a transcript tailer this coordinator depends on. TranscriptTailer
// satisfies it structurally; tests pass a fake.
export type Tailer = {
  readNew(): TranscriptActivity[];
  contextTokens: number | null;
  lastMessage: string | null;
};

// The agent's context window in tokens, inferred from the model id (e.g.
// "claude-opus-4-8[1m]" carries a 1M window); a conservative default otherwise.
export function contextWindowFor(model: string | undefined): number {
  if (model && /\[1m\]/i.test(model)) return 1_000_000;
  return 200_000;
}

// A subagent's transcript lives beside the main one, under <session>/subagents.
// Prefer the explicit path the hook hands us; otherwise derive it from the main
// transcript path.
export function subagentTranscriptPath(
  explicit: unknown,
  mainPath: unknown,
  agentId: unknown,
): string | null {
  if (typeof explicit === "string") return explicit;
  if (typeof mainPath !== "string" || !mainPath.endsWith(".jsonl") || !agentId) {
    return null;
  }
  return `${mainPath.slice(0, -".jsonl".length)}/subagents/agent-${String(agentId)}.jsonl`;
}

// Coordinates per-session transcript tailers with the domain registries: drains
// each tailer's new activity, applies it to the agent, and performs the work-dir
// and file side effects it resolves. One tailer per session, keyed by terminal
// id (or "t1:sub:<id>" for a subagent).
export class TranscriptSync {
  private tailers = new Map<string, { path: string; tailer: Tailer }>();
  private models = new Map<string, string>();
  private readonly agents: AgentRegistry;
  private readonly files: FileRegistry;
  private readonly workDirs: WorkDirTracker;
  private readonly markWorldDirty: () => void;
  private readonly makeTailer: (path: string) => Tailer;

  constructor(
    agents: AgentRegistry,
    files: FileRegistry,
    workDirs: WorkDirTracker,
    markWorldDirty: () => void,
    makeTailer: (path: string) => Tailer = (p) => new TranscriptTailer(p),
  ) {
    this.agents = agents;
    this.files = files;
    this.workDirs = workDirs;
    this.markWorldDirty = markWorldDirty;
    this.makeTailer = makeTailer;
  }

  setModel(session: string, model: string): void {
    this.models.set(session, model);
  }

  register(key: string, path: unknown): void {
    if (typeof path !== "string" || !path) return;
    const existing = this.tailers.get(key);
    if (existing && existing.path === path) return;
    this.tailers.set(key, { path, tailer: this.makeTailer(path) });
  }

  keys(): string[] {
    return [...this.tailers.keys()];
  }

  delete(id: string): void {
    this.tailers.delete(id);
  }

  // Drop a session's tailers (its own and its subagents') and its model.
  removeForSession(session: string): void {
    for (const key of [...this.tailers.keys()]) {
      if (key === session || key.startsWith(`${session}:sub:`)) {
        this.tailers.delete(key);
      }
    }
    this.models.delete(session);
  }

  // Drain one agent's tailer (main session or subagent), applying any newly
  // appended activity and refreshing its context fill and last message.
  pump(agentId: string): void {
    const entry = this.tailers.get(agentId);
    const agent = this.agents.get(agentId);
    if (!entry || !agent) return;
    const now = Date.now();
    for (const act of entry.tailer.readNew()) this.apply(agent, act, now);

    // Context fill drives the base brownout, which is the main agent's terminal.
    if (agent.kind === "agent" && entry.tailer.contextTokens !== null) {
      agent.contextFraction = Math.min(
        1,
        entry.tailer.contextTokens / contextWindowFor(this.models.get(agent.terminal)),
      );
    }
    if (entry.tailer.lastMessage !== null) agent.lastMessage = entry.tailer.lastMessage;
  }

  private apply(agent: Agent, act: TranscriptActivity, now: number): void {
    const applied = this.agents.applyActivity(agent, act, now);
    if (!applied) return;
    if (this.workDirs.touch(applied.dir, now)) this.markWorldDirty();
    if (applied.filePath && applied.direction !== "run") {
      this.files.record(
        applied.dir,
        applied.filePath,
        applied.direction === "read" ? "read" : "write",
        now,
      );
    }
  }
}
