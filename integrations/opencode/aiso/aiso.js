// AIso adapter for opencode. Streams tool calls to the AIso map (POST /ingest)
// so the agent's reads, writes, and commands animate on its terminal island.
//
// It posts the same Claude-shaped payload the server already understands, plus
// an `X-Aiso-Tool: opencode` header so the robot uses the opencode art. The
// AIso terminal injects AISO_INGEST / AISO_TOKEN / AISO_SESSION, which tie the
// events to the right island and authorize the local endpoint.

const INGEST = process.env.AISO_INGEST;
const TOKEN = process.env.AISO_TOKEN;
const SESSION = process.env.AISO_SESSION;

const TOOL_MAP = {
  read: "Read",
  write: "Write",
  edit: "Write",
  patch: "Write",
  apply_patch: "Write",
  bash: "Bash",
};

async function send(body) {
  if (!INGEST || !SESSION) return;
  try {
    await fetch(INGEST, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TOKEN}`,
        "x-aiso-session": SESSION,
        "x-aiso-tool": "opencode",
      },
      body: JSON.stringify(body),
    });
  } catch {
    // Best effort: never block the agent on the visualizer.
  }
}

export const AIso = async ({ directory }) => {
  await send({ hook_event_name: "SessionStart" });
  return {
    "tool.execute.after": async (input) => {
      const args = (input && input.args) || {};
      await send({
        hook_event_name: "PostToolUse",
        tool_name: TOOL_MAP[input.tool] || input.tool,
        tool_input: {
          file_path: args.filePath || args.path || args.file,
          command: args.command,
        },
        cwd: directory,
      });
    },
  };
};

export default AIso;
