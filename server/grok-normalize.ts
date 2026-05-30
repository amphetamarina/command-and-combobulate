import { join } from "node:path";

export type ClaudeHook = {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: { file_path?: unknown; command?: unknown };
  tool_response?: unknown;
  transcript_path?: unknown;
  model?: unknown;
  agent_id?: unknown;
  agent_type?: unknown;
  cwd?: unknown;
};

const GROK_EVENTS: Record<string, string> = {
  session_start: "SessionStart",
  session_end: "SessionEnd",
  pre_tool_use: "PreToolUse",
  post_tool_use: "PostToolUse",
  subagent_start: "SubagentStart",
  subagent_stop: "SubagentStop",
};

// Grok ships a camelCased payload with snake_case lifecycle names and its own
// tool taxonomy (read_file / list_dir / run_command, with target_file and
// target_directory as relative paths). Translate it into the Claude-shaped
// event the rest of the pipeline already understands, resolving relative paths
// against cwd so they land in the right folder region.
export function normalizeGrokPayload(raw: Record<string, unknown>): ClaudeHook {
  const event = typeof raw.hookEventName === "string" ? raw.hookEventName : "";
  const toolName = typeof raw.toolName === "string" ? raw.toolName : "";
  const cwd = typeof raw.cwd === "string" ? raw.cwd : "";
  const input =
    raw.toolInput && typeof raw.toolInput === "object"
      ? (raw.toolInput as Record<string, unknown>)
      : {};

  const lower = toolName.toLowerCase();
  let bucket = "Write";
  if (/read|cat|view/.test(lower)) bucket = "Read";
  else if (/run_command|run_terminal|bash|shell|exec|terminal/.test(lower))
    bucket = "Bash";

  const rel =
    (typeof input.target_file === "string" && input.target_file) ||
    (typeof input.target_directory === "string" && input.target_directory) ||
    (typeof input.file_path === "string" && input.file_path) ||
    (typeof input.path === "string" && input.path) ||
    "";
  let filePath = "";
  if (rel.startsWith("/")) filePath = rel;
  else if (rel && cwd.startsWith("/")) filePath = join(cwd, rel);

  const command =
    (typeof input.command === "string" && input.command) ||
    (typeof input.cmd === "string" && input.cmd) ||
    "";

  const mapped = GROK_EVENTS[event];
  const out: ClaudeHook = {
    tool_name: bucket,
    tool_input: {
      ...(filePath ? { file_path: filePath } : {}),
      ...(command ? { command } : {}),
    },
    cwd,
  };
  if (mapped) out.hook_event_name = mapped;
  return out;
}
