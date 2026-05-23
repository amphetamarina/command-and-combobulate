import type { BuildingDescriptor, Region } from "../shared/types.ts";
import type { ProcsResponse } from "../shared/proc-types.ts";

export type WorldResponse = {
  buildings: BuildingDescriptor[];
  regions: Region[];
};

export async function fetchWorld(): Promise<WorldResponse> {
  const res = await fetch("/world");
  if (!res.ok) {
    throw new Error(`/world responded ${res.status}`);
  }
  return (await res.json()) as WorldResponse;
}

export async function fetchProcs(): Promise<ProcsResponse> {
  const res = await fetch("/procs");
  if (!res.ok) {
    throw new Error(`/procs responded ${res.status}`);
  }
  return (await res.json()) as ProcsResponse;
}

const DEFAULT_API_PORT = 3001;

export function liveSocketUrl(): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const port = location.port === "5173" ? DEFAULT_API_PORT : location.port;
  const host = port ? `${location.hostname}:${port}` : location.hostname;
  return `${proto}://${host}/live`;
}
