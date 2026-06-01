import type { Region } from "./types.ts";

// What an agent is doing, distinct from where: the verb refines the coarse
// read/write/run direction with the actual tool intent (a destructive `rm` vs a
// `cargo build`), so the map can show the kind of work, not just its location.
export type ActivityVerb =
  | "read"
  | "edit"
  | "search"
  | "run"
  | "build"
  | "destroy"
  | "fetch"
  | "spawn";

// The role of a touched file, so the map can give it a meaningful building
// instead of a hash-picked civilian house.
export type FileRole =
  | "source"
  | "test"
  | "config"
  | "manifest"
  | "docs"
  | "build"
  | "other";

// How a tool action resolved: "pending" while it is still running (the tool_use
// was seen but no result yet), then "ok" or "error" once the result arrives.
export type Outcome = "pending" | "ok" | "error";

export type FileActivity = {
  path: string;
  dir: string;
  direction: "read" | "write" | "run";
  verb: ActivityVerb;
  outcome: Outcome;
};

// One robot on the map: an agent (or one of its subagents) reported by an
// in-terminal adapter, not scraped from /proc.
export type AgentSnapshot = {
  id: string; // stable per agent/subagent (e.g. terminal id, or "t1:sub:<x>")
  terminal: string | null; // the terminal island it lives on
  kind: "agent" | "subagent";
  parent: string | null;
  tool: string; // robot art source: "claude" | "codex"
  label: string; // display label
  activity: FileActivity | null; // the folder it is currently working in
  recent: string[]; // recent human-readable actions, newest first
  // How full the agent's context window is (0..1), from transcript usage, or
  // null when unknown. Drives the base "brownout" as the agent fills up.
  contextFraction: number | null;
  // The agent's most recent prose (what it last said), shown over its terminal.
  lastMessage: string | null;
};

// A file an agent has touched, shown as an icon on its folder island.
export type FileEntry = {
  path: string;
  name: string;
  size: number;
  direction: "read" | "write";
  role: FileRole;
  ts: number;
};

export type FolderFiles = { dir: string; entries: FileEntry[] };
