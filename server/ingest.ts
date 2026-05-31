import { AgentRegistry, subId } from "./agents.ts";
import { TranscriptSync, subagentTranscriptPath } from "./transcript-sync.ts";

// The hook payload an adapter POSTs to /ingest, shaped like a Claude Code hook
// event. Each adapter normalises its own format into this before sending.
export type ClaudeHook = {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: { file_path?: unknown; command?: unknown };
  tool_response?: unknown;
  transcript_path?: unknown;
  agent_transcript_path?: unknown;
  model?: unknown;
  agent_id?: unknown;
  agent_type?: unknown;
  cwd?: unknown;
};

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
