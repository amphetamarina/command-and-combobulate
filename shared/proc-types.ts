import type { Region } from "./types.ts";

export type FileActivity = {
  path: string;
  dir: string;
  direction: "read" | "write";
};

// One robot on the map: an agent (or one of its subagents) reported by an
// in-terminal adapter, not scraped from /proc.
export type AgentSnapshot = {
  id: string; // stable per agent/subagent (e.g. terminal id, or "t1:sub:<x>")
  terminal: string | null; // the terminal island it lives on
  kind: "agent" | "subagent";
  parent: string | null;
  tool: string; // robot art source: "claude" | "opencode" | ...
  label: string; // display label
  activity: FileActivity | null; // the folder it is currently working in
};

// A file an agent has touched, shown as an icon on its folder island.
export type FileEntry = {
  path: string;
  name: string;
  size: number;
  direction: "read" | "write";
  ts: number;
};

export type FolderFiles = { dir: string; entries: FileEntry[] };

export type FileContent = {
  path: string;
  name: string;
  size: number;
  content: string;
  truncated: boolean;
};

export type LiveMessage =
  | {
      kind: "agents";
      capturedAt: number;
      agents: AgentSnapshot[];
    }
  | {
      kind: "world-delta";
      regions: Region[];
    }
  | {
      kind: "files";
      files: FolderFiles[];
    };
