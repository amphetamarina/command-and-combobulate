// Command & Clanker adapter for opencode. Streams tool calls to the map
// (POST /ingest) so the agent's reads, writes, and commands animate on its
// terminal island.
//
// It posts the same Claude-shaped payload the server already understands, plus
// an `X-Clanker-Tool: opencode` header so the robot uses the opencode art. The
// Command & Clanker terminal injects CLANKER_INGEST / CLANKER_TOKEN /
// CLANKER_SESSION, which tie the events to the right island and authorize the
// local endpoint.
//
// Subagents run in child opencode sessions (a session with a parentID). We
// track those and tag their tool calls with `agent_id` so they render as their
// own smaller robots.

const INGEST = process.env.CLANKER_INGEST;
const TOKEN = process.env.CLANKER_TOKEN;
const SESSION = process.env.CLANKER_SESSION;

const TOOL_MAP = {
  read: "Read",
  write: "Write",
  edit: "Write",
  patch: "Write",
  apply_patch: "Write",
  bash: "Bash",
};

const childSessions = new Set();

async function send(body) {
  if (!INGEST || !SESSION) return;
  try {
    await fetch(INGEST, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TOKEN}`,
        "x-clanker-session": SESSION,
        "x-clanker-tool": "opencode",
      },
      body: JSON.stringify(body),
    });
  } catch {
    // Best effort: never block the agent on the visualizer.
  }
}

export const Clanker = async ({ directory }) => {
  await send({ hook_event_name: "SessionStart" });
  return {
    "tool.execute.after": async (input) => {
      const args = (input && input.args) || {};
      const isChild = childSessions.has(input && input.sessionID);
      await send({
        hook_event_name: "PostToolUse",
        tool_name: TOOL_MAP[input.tool] || input.tool,
        tool_input: {
          file_path: args.filePath || args.path || args.file,
          command: args.command,
        },
        cwd: directory,
        agent_id: isChild ? input.sessionID : undefined,
      });
    },
    event: async ({ event }) => {
      const type = event && event.type;
      const p = (event && event.properties) || {};
      if (type === "session.created") {
        const id = p.id || (p.session && p.session.id) || p.sessionID;
        const parent = p.parentID || (p.session && p.session.parentID);
        if (id && parent) {
          childSessions.add(id);
          await send({
            hook_event_name: "SubagentStart",
            agent_id: id,
            agent_type: "subagent",
          });
        }
      } else if (type === "session.idle" || type === "session.deleted") {
        const id = p.sessionID || p.id;
        if (id && childSessions.has(id)) {
          childSessions.delete(id);
          await send({ hook_event_name: "SubagentStop", agent_id: id });
        }
      }
    },
  };
};

export default Clanker;
