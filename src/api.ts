import type { Region } from "../shared/types.ts";
import type { FileContent } from "../shared/proc-types.ts";

export type WorldResponse = {
  regions: Region[];
};

export async function fetchWorld(): Promise<WorldResponse> {
  const res = await fetch("/world");
  if (!res.ok) {
    throw new Error(`/world responded ${res.status}`);
  }
  return (await res.json()) as WorldResponse;
}

export async function fetchFile(path: string): Promise<FileContent> {
  const res = await fetch(`/file?path=${encodeURIComponent(path)}`);
  if (!res.ok) {
    throw new Error(`/file responded ${res.status}`);
  }
  return (await res.json()) as FileContent;
}

const DEFAULT_API_PORT = 3001;

function apiSocketBase(): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const port = location.port === "5173" ? DEFAULT_API_PORT : location.port;
  const host = port ? `${location.hostname}:${port}` : location.hostname;
  return `${proto}://${host}`;
}

export function liveSocketUrl(): string {
  return `${apiSocketBase()}/live`;
}

export function termSocketUrl(id: string): string {
  return `${apiSocketBase()}/term?id=${encodeURIComponent(id)}`;
}

export async function createTerminal(
  cols?: number,
  rows?: number,
): Promise<string | null> {
  try {
    const res = await fetch("/term/new", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cols, rows }),
    });
    if (!res.ok) return null;
    return ((await res.json()) as { id: string }).id;
  } catch {
    return null;
  }
}

export function killTerminal(id: string): void {
  void fetch("/term/kill", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id }),
  }).catch(() => {});
}
