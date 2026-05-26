import type { BuildingDescriptor, Region } from "./types.ts";

export type FileActivity = {
  path: string;
  dir: string;
  direction: "read" | "write";
};

export type ProcessSnapshot = {
  pid: number;
  ppid: number;
  // The id of the in-app terminal this process descends from, or null.
  terminal: string | null;
  exe: string;
  comm: string;
  cpu: number;
  mem: number;
  activity: FileActivity | null;
};

export type ProcsResponse = {
  capturedAt: number;
  processes: ProcessSnapshot[];
};

export type LiveMessage =
  | {
      kind: "procs";
      capturedAt: number;
      processes: ProcessSnapshot[];
    }
  | {
      kind: "world-delta";
      buildings: BuildingDescriptor[];
      regions: Region[];
    };
