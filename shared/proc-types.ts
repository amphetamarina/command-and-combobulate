import type { BuildingDescriptor, Region } from "./types.ts";

export type ProcessSnapshot = {
  pid: number;
  exe: string;
  comm: string;
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
