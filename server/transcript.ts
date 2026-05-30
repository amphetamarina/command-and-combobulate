import { openSync, readSync, closeSync, statSync } from "node:fs";
import type { ActivityVerb } from "../shared/proc-types.ts";
import { classifyVerb } from "./classify.ts";

// A tool invocation read from an assistant entry, before its result is known.
export type RawUse = {
  id: string;
  name: string;
  input: Record<string, unknown>;
  cwd: string | null;
  ts: number;
  isSidechain: boolean;
};

export type RawResult = { id: string; isError: boolean };

// A normalized, placeable activity derived from the transcript. Emitted twice
// per tool: once when the tool_use is seen (ok null, the agent starts working)
// and once when its tool_result arrives (ok set from is_error).
export type TranscriptActivity = {
  toolUseId: string;
  tool: string;
  filePath: string | null;
  command: string | null;
  cwd: string | null;
  verb: ActivityVerb;
  direction: "read" | "write" | "run";
  ok: boolean | null;
  ts: number;
  isSidechain: boolean;
};

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

// The total context (prompt) size for an assistant turn: the live input plus
// both cache tiers. Output tokens are the reply, not context, so excluded.
function usageContextTokens(usage: unknown): number | null {
  if (!usage || typeof usage !== "object") return null;
  const u = usage as Record<string, unknown>;
  let sum = 0;
  for (const k of ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"]) {
    if (typeof u[k] === "number") sum += u[k] as number;
  }
  return sum > 0 ? sum : null;
}

export function parseTranscriptLine(line: string): {
  uses: RawUse[];
  results: RawResult[];
  contextTokens: number | null;
  text: string | null;
} {
  const uses: RawUse[] = [];
  const results: RawResult[] = [];
  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return { uses, results, contextTokens: null, text: null };
  }
  const message = entry.message as { content?: unknown; usage?: unknown } | undefined;
  const contextTokens = usageContextTokens(message?.usage);
  const content = message?.content;
  if (!Array.isArray(content)) return { uses, results, contextTokens, text: null };

  const cwd = asString(entry.cwd);
  const tsStr = asString(entry.timestamp);
  const ts = tsStr ? Date.parse(tsStr) || 0 : 0;
  const isSidechain = entry.isSidechain === true;

  const texts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const it = item as Record<string, unknown>;
    if (it.type === "tool_use" && typeof it.name === "string" && typeof it.id === "string") {
      uses.push({
        id: it.id,
        name: it.name,
        input: (it.input && typeof it.input === "object" ? it.input : {}) as Record<string, unknown>,
        cwd,
        ts,
        isSidechain,
      });
    } else if (it.type === "tool_result" && typeof it.tool_use_id === "string") {
      results.push({ id: it.tool_use_id, isError: it.is_error === true });
    } else if (it.type === "text" && typeof it.text === "string") {
      texts.push(it.text);
    }
  }
  const text = texts.length > 0 ? texts.join(" ").replace(/\s+/g, " ").trim() || null : null;
  return { uses, results, contextTokens, text };
}

// The most recent context size across a batch of lines, or null if none of them
// carried usage (so a caller can keep the last known value).
export function latestContextTokens(lines: string[]): number | null {
  let last: number | null = null;
  for (const line of lines) {
    const { contextTokens } = parseTranscriptLine(line);
    if (contextTokens !== null) last = contextTokens;
  }
  return last;
}

// The most recent assistant prose across a batch of lines (what the agent last
// said), or null if none carried text.
export function latestMessage(lines: string[]): string | null {
  let last: string | null = null;
  for (const line of lines) {
    const { text } = parseTranscriptLine(line);
    if (text) last = text;
  }
  return last;
}

// Tools placed on the map: file tools (a file_path), and tools that act in the
// session's cwd -- Bash, search (Grep/Glob), and external fetch (WebFetch/
// WebSearch). Their verb drives the on-map machine; fetch is anchored at cwd
// but its aircraft flies to the terminal regardless.
const CWD_TOOLS = new Set(["Bash", "Grep", "Glob", "WebFetch", "WebSearch"]);
function placeable(use: RawUse): boolean {
  return typeof use.input.file_path === "string" || CWD_TOOLS.has(use.name);
}

export function useToActivity(use: RawUse, ok: boolean | null): TranscriptActivity {
  const filePath = asString(use.input.file_path);
  const command = asString(use.input.command);
  const direction: "read" | "write" | "run" =
    use.name === "Read" ? "read" : filePath ? "write" : "run";
  return {
    toolUseId: use.id,
    tool: use.name,
    filePath,
    command,
    cwd: use.cwd,
    verb: classifyVerb(use.name, command ?? ""),
    direction,
    ok,
    ts: use.ts,
    isSidechain: use.isSidechain,
  };
}

// Fold a batch of transcript lines into activities, carrying unmatched tool_uses
// in `pending` so a use in one batch pairs with a result in a later batch.
export function ingestLines(lines: string[], pending: Map<string, RawUse>): TranscriptActivity[] {
  const out: TranscriptActivity[] = [];
  for (const line of lines) {
    const { uses, results } = parseTranscriptLine(line);
    for (const use of uses) {
      if (!placeable(use)) continue;
      pending.set(use.id, use);
      out.push(useToActivity(use, null));
    }
    for (const result of results) {
      const use = pending.get(result.id);
      if (!use) continue;
      pending.delete(result.id);
      out.push(useToActivity(use, !result.isError));
    }
  }
  return out;
}

// Tails one transcript file: tracks a byte offset and a buffer for the trailing
// partial line, so each readNew() returns only activities from newly appended,
// complete JSONL lines. Starts at the file's current end so reconnecting to a
// live session does not replay its whole history.
export class TranscriptTailer {
  private readonly path: string;
  private offset: number;
  private buffer = "";
  private readonly pending = new Map<string, RawUse>();
  // The latest assistant-turn context size seen, kept across reads so a tick
  // that appends no usage line still reports the last known value.
  contextTokens: number | null = null;
  // The latest assistant prose seen (what the agent last said), kept similarly.
  lastMessage: string | null = null;

  constructor(path: string) {
    this.path = path;
    let size = 0;
    try {
      size = statSync(path).size;
    } catch {
      /* not created yet; start at 0 */
    }
    this.offset = size;
  }

  readNew(): TranscriptActivity[] {
    let size: number;
    try {
      size = statSync(this.path).size;
    } catch {
      return [];
    }
    // The file was truncated or replaced (e.g. a new session reused the path).
    if (size < this.offset) {
      this.offset = 0;
      this.buffer = "";
    }
    if (size === this.offset) return [];

    let chunk = "";
    let fd: number | null = null;
    try {
      fd = openSync(this.path, "r");
      const len = size - this.offset;
      const buf = Buffer.allocUnsafe(len);
      const read = readSync(fd, buf, 0, len, this.offset);
      chunk = buf.subarray(0, read).toString("utf8");
      this.offset += read;
    } catch {
      return [];
    } finally {
      if (fd !== null) closeSync(fd);
    }

    this.buffer += chunk;
    const newlineEnd = this.buffer.lastIndexOf("\n");
    if (newlineEnd === -1) return [];
    const complete = this.buffer.slice(0, newlineEnd);
    this.buffer = this.buffer.slice(newlineEnd + 1);
    const lines = complete.split("\n").filter((l) => l.length > 0);
    const ctx = latestContextTokens(lines);
    if (ctx !== null) this.contextTokens = ctx;
    const msg = latestMessage(lines);
    if (msg !== null) this.lastMessage = msg;
    return ingestLines(lines, this.pending);
  }
}
