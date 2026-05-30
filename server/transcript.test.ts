import { test, expect } from "bun:test";
import {
  parseTranscriptLine,
  ingestLines,
  latestContextTokens,
  latestMessage,
  type RawUse,
} from "./transcript.ts";

// Faithful to the real Claude Code transcript schema: tool_use items live in
// assistant messages, tool_result items in user messages, paired by id, with a
// top-level cwd/timestamp/isSidechain. (Derived from captured transcripts.)
const asstUse = (id: string, name: string, input: unknown, cwd = "/p") =>
  JSON.stringify({
    type: "assistant",
    cwd,
    timestamp: "2026-05-28T18:20:00.000Z",
    isSidechain: false,
    message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
  });

const userResult = (id: string, isError: boolean) =>
  JSON.stringify({
    type: "user",
    cwd: "/p",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: isError }] },
  });

test("parseTranscriptLine extracts a tool_use from an assistant entry", () => {
  const { uses, results } = parseTranscriptLine(
    asstUse("tu1", "Bash", { command: "ls ./non-existent" }),
  );
  expect(results).toEqual([]);
  expect(uses).toHaveLength(1);
  expect(uses[0]!.id).toBe("tu1");
  expect(uses[0]!.name).toBe("Bash");
  expect(uses[0]!.cwd).toBe("/p");
  expect(uses[0]!.isSidechain).toBe(false);
});

test("parseTranscriptLine extracts a tool_result from a user entry", () => {
  const { uses, results } = parseTranscriptLine(userResult("tu1", true));
  expect(uses).toEqual([]);
  expect(results).toEqual([{ id: "tu1", isError: true }]);
});

test("parseTranscriptLine ignores non-message and malformed lines", () => {
  const empty = { uses: [], results: [], contextTokens: null, text: null };
  expect(parseTranscriptLine('{"type":"file-history-snapshot"}')).toEqual(empty);
  expect(parseTranscriptLine("not json")).toEqual(empty);
  expect(parseTranscriptLine("")).toEqual(empty);
});

test("parseTranscriptLine extracts and collapses assistant text", () => {
  const line = JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "Let me check\n  the config" },
        { type: "tool_use", id: "u", name: "Read", input: { file_path: "/p/x" } },
      ],
    },
  });
  const parsed = parseTranscriptLine(line);
  expect(parsed.text).toBe("Let me check the config");
  expect(parsed.uses).toHaveLength(1);
});

test("latestMessage returns the last assistant prose seen", () => {
  const say = (t: string) =>
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: t }] } });
  const toolOnly = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "u", name: "Read", input: {} }] },
  });
  expect(latestMessage([say("first"), toolOnly, say("second")])).toBe("second");
  expect(latestMessage([toolOnly])).toBe(null);
});

test("parseTranscriptLine sums context tokens from an assistant usage block", () => {
  const line = JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      usage: {
        input_tokens: 7848,
        cache_creation_input_tokens: 3356,
        cache_read_input_tokens: 16202,
        output_tokens: 121,
      },
    },
  });
  // input + cache_creation + cache_read; output excluded.
  expect(parseTranscriptLine(line).contextTokens).toBe(7848 + 3356 + 16202);
});

test("latestContextTokens returns the last usage seen, ignoring lines without it", () => {
  const turn = (input: number) =>
    JSON.stringify({ type: "assistant", message: { content: [], usage: { input_tokens: input } } });
  const noUsage = JSON.stringify({ type: "user", message: { content: [] } });
  expect(latestContextTokens([turn(100), noUsage, turn(250), noUsage])).toBe(250);
  expect(latestContextTokens([noUsage, noUsage])).toBe(null);
});

test("ingestLines pairs a failing Bash use with its result -> ok false", () => {
  const pending = new Map<string, RawUse>();
  const out = ingestLines(
    [asstUse("tu1", "Bash", { command: "ls ./non-existent" }), userResult("tu1", true)],
    pending,
  );
  // a start (ok null) then a completion (ok false)
  expect(out).toHaveLength(2);
  expect(out[0]).toMatchObject({ toolUseId: "tu1", verb: "run", direction: "run", ok: null });
  expect(out[1]).toMatchObject({ toolUseId: "tu1", verb: "run", direction: "run", ok: false, command: "ls ./non-existent" });
  expect(pending.size).toBe(0);
});

test("ingestLines treats a piped test command that exits 0 as ok true", () => {
  // `bun test 2>&1 | tail` fails the suite but the command exits 0, so the
  // transcript records is_error:false -- and we must honour that.
  const out = ingestLines(
    [asstUse("t", "Bash", { command: "bun test 2>&1 | tail -40" }), userResult("t", false)],
    new Map(),
  );
  expect(out[1]).toMatchObject({ ok: true, verb: "run" });
});

test("ingestLines maps a Read use to a read activity with its file path", () => {
  const out = ingestLines(
    [asstUse("r", "Read", { file_path: "/p/server.js" }), userResult("r", false)],
    new Map(),
  );
  expect(out[1]).toMatchObject({
    tool: "Read",
    verb: "read",
    direction: "read",
    filePath: "/p/server.js",
    ok: true,
  });
});

test("ingestLines maps a Write use to an edit activity", () => {
  const out = ingestLines(
    [asstUse("w", "Write", { file_path: "/p/x.cs", content: "..." }), userResult("w", false)],
    new Map(),
  );
  expect(out[1]).toMatchObject({ verb: "edit", direction: "write", filePath: "/p/x.cs", ok: true });
});

test("ingestLines correlates a use and result split across calls", () => {
  const pending = new Map<string, RawUse>();
  const first = ingestLines([asstUse("tu1", "Bash", { command: "make" })], pending);
  expect(first).toHaveLength(1);
  expect(first[0]).toMatchObject({ verb: "build", ok: null });
  expect(pending.size).toBe(1);

  const second = ingestLines([userResult("tu1", false)], pending);
  expect(second).toHaveLength(1);
  expect(second[0]).toMatchObject({ toolUseId: "tu1", verb: "build", ok: true });
  expect(pending.size).toBe(0);
});

test("ingestLines drops a result with no matching pending use", () => {
  const out = ingestLines([userResult("orphan", true)], new Map());
  expect(out).toEqual([]);
});

test("ingestLines maps search and fetch tools to cwd-anchored activities", () => {
  const search = ingestLines(
    [asstUse("g", "Grep", { pattern: "foo" }), userResult("g", false)],
    new Map(),
  );
  expect(search[0]).toMatchObject({ tool: "Grep", verb: "search", cwd: "/p" });

  const fetch = ingestLines(
    [asstUse("f", "WebFetch", { url: "https://x" }), userResult("f", false)],
    new Map(),
  );
  expect(fetch[0]).toMatchObject({ tool: "WebFetch", verb: "fetch", cwd: "/p" });
});

test("ingestLines still skips a tool with neither a file nor a cwd anchor", () => {
  const out = ingestLines(
    [asstUse("t", "TodoWrite", { todos: [] }), userResult("t", false)],
    new Map(),
  );
  expect(out).toEqual([]);
});

test("ingestLines preserves the sidechain flag", () => {
  const line = JSON.stringify({
    type: "assistant",
    cwd: "/p",
    isSidechain: true,
    message: { role: "assistant", content: [{ type: "tool_use", id: "s", name: "Bash", input: { command: "ls" } }] },
  });
  const out = ingestLines([line], new Map());
  expect(out[0]!.isSidechain).toBe(true);
});
