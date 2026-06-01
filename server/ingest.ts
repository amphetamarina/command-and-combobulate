import { AgentRegistry, subId } from "./agents.ts";
import { TranscriptSync, subagentTranscriptPath } from "./transcript-sync.ts";

// The hook payload an adapter POSTs to /ingest, shaped like a Claude Code hook
// event. Each adapter normalises its own format into this before sending.
export type ClaudeHook = {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: { file_path?: unknown; command?: unknown };
  tool_response?: unknown;
  transcript_path?: string;
  agent_transcript_path?: string;
  model?: string;
  agent_id?: string | number;
  agent_type?: string;
  cwd?: string;
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Narrow an untrusted /ingest body to a ClaudeHook, keeping only well-typed
// fields and dropping the rest. Returns null when the payload is not even an
// object, so the handler can ignore it. Malformed-but-object payloads are
// coerced rather than rejected, preserving the "ack and ignore junk" contract.
export function parseHook(raw: unknown): ClaudeHook | null {
  if (!isPlainObject(raw)) return null;
  const hook: ClaudeHook = {};
  if (typeof raw.hook_event_name === "string") hook.hook_event_name = raw.hook_event_name;
  if (typeof raw.tool_name === "string") hook.tool_name = raw.tool_name;
  if (isPlainObject(raw.tool_input)) hook.tool_input = raw.tool_input;
  if ("tool_response" in raw) hook.tool_response = raw.tool_response;
  if (typeof raw.transcript_path === "string") hook.transcript_path = raw.transcript_path;
  if (typeof raw.agent_transcript_path === "string") {
    hook.agent_transcript_path = raw.agent_transcript_path;
  }
  if (typeof raw.model === "string") hook.model = raw.model;
  if (typeof raw.agent_id === "string" || typeof raw.agent_id === "number") {
    hook.agent_id = raw.agent_id;
  }
  if (typeof raw.agent_type === "string") hook.agent_type = raw.agent_type;
  if (typeof raw.cwd === "string") hook.cwd = raw.cwd;
  return hook;
}

// The session-lifecycle state machine. Translates a hook event into agent and
// transcript-tailer lifecycle: start/end a session, start/stop a subagent, and
// (on a tool-use poke) drain whichever transcript just advanced.
export class Ingest {
  private sessionTool = new Map<string, string>();
  private readonly agents: AgentRegistry;
  private readonly transcripts: TranscriptSync;
  private readonly markWorldDirty: () => void;

  constructor(
    agents: AgentRegistry,
    transcripts: TranscriptSync,
    markWorldDirty: () => void,
  ) {
    this.agents = agents;
    this.transcripts = transcripts;
    this.markWorldDirty = markWorldDirty;
  }

  handle(session: string, tool: string, body: ClaudeHook): void {
    this.sessionTool.set(session, tool);
    if (typeof body.model === "string") this.transcripts.setModel(session, body.model);
    this.transcripts.register(session, body.transcript_path);
    switch (body.hook_event_name) {
      case "SessionStart":
        this.agents.ensureAgent(session, tool);
        return;
      case "SessionEnd":
      case "Stop":
        this.agents.removeSession(session);
        this.transcripts.removeForSession(session);
        this.sessionTool.delete(session);
        this.markWorldDirty();
        return;
      case "SubagentStart": {
        this.agents.ensureSubagent(
          session,
          body.agent_id,
          tool,
          typeof body.agent_type === "string" ? body.agent_type : "subagent",
        );
        // Tail the subagent's own transcript so its tool calls show on the map.
        this.transcripts.register(
          subId(session, body.agent_id),
          subagentTranscriptPath(
            body.agent_transcript_path,
            body.transcript_path,
            body.agent_id,
          ),
        );
        return;
      }
      case "SubagentStop": {
        const id = subId(session, body.agent_id);
        this.transcripts.pump(id);
        this.agents.delete(id);
        this.transcripts.delete(id);
        return;
      }
      case "PreToolUse":
      case "PostToolUse":
        // The activity itself comes from the transcript, not this payload; the
        // hook is only a poke to read whatever lines have just landed. Pump the
        // subagent's transcript when the call came from one, else the main agent.
        if (body.agent_id) {
          this.transcripts.pump(subId(session, body.agent_id));
        } else {
          this.agents.ensureAgent(session, tool);
          this.transcripts.pump(session);
        }
        return;
      default:
        return;
    }
  }

  forgetSession(session: string): void {
    this.sessionTool.delete(session);
  }
}
