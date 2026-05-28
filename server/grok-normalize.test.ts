import { describe, expect, test } from "bun:test";
import { normalizeGrokPayload } from "./grok-normalize.ts";

describe("normalizeGrokPayload", () => {
  test("maps session_start to SessionStart", () => {
    const out = normalizeGrokPayload({
      hookEventName: "session_start",
      sessionId: "abc",
      cwd: "/work",
    });
    expect(out.hook_event_name).toBe("SessionStart");
  });

  test("maps post_tool_use read_file and resolves relative target_file", () => {
    const out = normalizeGrokPayload({
      hookEventName: "post_tool_use",
      toolName: "read_file",
      cwd: "/home/me/proj",
      toolInput: { target_file: "src/index.ts" },
    });
    expect(out.hook_event_name).toBe("PostToolUse");
    expect(out.tool_name).toBe("Read");
    expect(out.tool_input?.file_path).toBe("/home/me/proj/src/index.ts");
    expect(out.cwd).toBe("/home/me/proj");
  });

  test("maps list_dir target_directory under cwd", () => {
    const out = normalizeGrokPayload({
      hookEventName: "post_tool_use",
      toolName: "list_dir",
      cwd: "/repo",
      toolInput: { target_directory: "." },
    });
    expect(out.tool_input?.file_path).toBe("/repo");
  });

  test("keeps absolute target_file as-is", () => {
    const out = normalizeGrokPayload({
      hookEventName: "post_tool_use",
      toolName: "read_file",
      cwd: "/repo",
      toolInput: { target_file: "/etc/hosts" },
    });
    expect(out.tool_input?.file_path).toBe("/etc/hosts");
  });

  test("buckets run_command as Bash and preserves command", () => {
    const out = normalizeGrokPayload({
      hookEventName: "post_tool_use",
      toolName: "run_command",
      cwd: "/repo",
      toolInput: { command: "ls -la" },
    });
    expect(out.tool_name).toBe("Bash");
    expect(out.tool_input?.command).toBe("ls -la");
  });

  test("unknown event leaves hook_event_name unset so the switch falls through", () => {
    const out = normalizeGrokPayload({
      hookEventName: "weird_event",
      cwd: "/repo",
    });
    expect(out.hook_event_name).toBeUndefined();
  });

  test("missing toolInput does not throw and yields empty file_path/command", () => {
    const out = normalizeGrokPayload({
      hookEventName: "post_tool_use",
      toolName: "read_file",
      cwd: "/repo",
    });
    expect(out.tool_input?.file_path).toBeUndefined();
    expect(out.tool_input?.command).toBeUndefined();
  });
});
