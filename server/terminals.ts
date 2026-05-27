import * as pty from "node-pty";
import xterm from "@xterm/headless";

const OUTPUT_BUFFER_CAP = 16384;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

export type TermClient = { send: (data: string) => void };

type HeadlessTerm = InstanceType<typeof xterm.Terminal>;

export type TermGrid = {
  cols: number;
  rows: number;
  cursorX: number;
  cursorY: number;
  lines: string[];
};

// Read the emulator's visible screen as plain-text rows plus the cursor
// position, so a non-DOM client (OpenRA) can paint a faithful terminal
// without reimplementing a VT parser.
export function readGrid(view: HeadlessTerm): TermGrid {
  const buf = view.buffer.active;
  const lines: string[] = [];
  for (let y = 0; y < view.rows; y++) {
    const line = buf.getLine(buf.viewportY + y);
    lines.push(line ? line.translateToString(true) : "");
  }
  return {
    cols: view.cols,
    rows: view.rows,
    cursorX: buf.cursorX,
    cursorY: buf.cursorY,
    lines,
  };
}

class Terminal {
  readonly id: string;
  readonly pid: number;
  private proc: pty.IPty;
  private buffer = "";
  private clients = new Set<TermClient>();
  private view: HeadlessTerm;
  private viewClients = new Set<TermClient>();
  private pushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    id: string,
    cols: number,
    rows: number,
    extraEnv: Record<string, string>,
    onExit: () => void,
  ) {
    this.id = id;
    const shell = process.env.SHELL ?? "bash";
    this.proc = pty.spawn(shell, ["-i"], {
      name: "xterm-256color",
      cols,
      rows,
      cwd: process.env.HOME ?? process.cwd(),
      env: { ...(process.env as Record<string, string>), ...extraEnv },
    });
    this.pid = this.proc.pid;
    // A headless emulator resolves the PTY's cursor moves and redraws into a
    // stable screen grid; raw-byte clients still get the unmodified stream.
    this.view = new xterm.Terminal({
      cols,
      rows,
      scrollback: 2000,
      allowProposedApi: true,
    });
    this.proc.onData((data) => {
      this.buffer = (this.buffer + data).slice(-OUTPUT_BUFFER_CAP);
      this.view.write(data);
      for (const client of this.clients) client.send(data);
      this.scheduleViewPush();
    });
    this.proc.onExit(() => onExit());
  }

  attach(client: TermClient) {
    if (this.buffer) client.send(this.buffer);
    this.clients.add(client);
  }

  detach(client: TermClient) {
    this.clients.delete(client);
  }

  attachView(client: TermClient) {
    this.viewClients.add(client);
    client.send(this.gridMessage());
  }

  detachView(client: TermClient) {
    this.viewClients.delete(client);
  }

  // Coalesce bursts of PTY output into at most one grid frame per ~40ms so a
  // redraw-heavy TUI does not flood the view clients.
  private scheduleViewPush() {
    if (this.pushTimer || this.viewClients.size === 0) return;
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      const msg = this.gridMessage();
      for (const client of this.viewClients) client.send(msg);
    }, 40);
  }

  private gridMessage(): string {
    return JSON.stringify({ kind: "term-grid", ...readGrid(this.view) });
  }

  write(data: string) {
    this.proc.write(data);
  }

  resize(cols: number, rows: number) {
    if (cols > 0 && rows > 0) {
      this.proc.resize(cols, rows);
      this.view.resize(cols, rows);
    }
  }

  kill() {
    if (this.pushTimer) {
      clearTimeout(this.pushTimer);
      this.pushTimer = null;
    }
    try {
      this.proc.kill();
    } catch {
      // already gone
    }
  }

  signal(sig: string) {
    try {
      this.proc.kill(sig);
    } catch {
      // already gone
    }
  }

  interrupt() {
    this.write("\x03");
  }

  inject(text: string) {
    this.write(text);
  }
}

export type IngestConfig = {
  url: string;
  token: string;
  pluginDir: string;
  opencodePlugin: string;
};

export class TerminalManager {
  private terminals = new Map<string, Terminal>();
  private seq = 0;
  private ingest: IngestConfig;

  constructor(ingest: IngestConfig) {
    this.ingest = ingest;
  }

  create(cols = DEFAULT_COLS, rows = DEFAULT_ROWS): string {
    const id = `t${++this.seq}`;
    // The agent's adapter reads these to tag its events with this island and
    // reach the ingest endpoint.
    const env = {
      CLANKER_SESSION: id,
      CLANKER_INGEST: this.ingest.url,
      CLANKER_TOKEN: this.ingest.token,
      CLANKER_PATH: this.ingest.pluginDir,
      CLANKER_OPENCODE: this.ingest.opencodePlugin,
    };
    this.terminals.set(
      id,
      new Terminal(id, cols, rows, env, () => this.terminals.delete(id)),
    );
    return id;
  }

  get(id: string): Terminal | undefined {
    return this.terminals.get(id);
  }

  list(): string[] {
    return [...this.terminals.keys()];
  }

  pids(): number[] {
    return [...this.terminals.values()].map((t) => t.pid);
  }

  refs(): { id: string; pid: number }[] {
    return [...this.terminals.entries()].map(([id, t]) => ({ id, pid: t.pid }));
  }

  kill(id: string) {
    this.terminals.get(id)?.kill();
    this.terminals.delete(id);
  }

  freeze(id: string) {
    this.terminals.get(id)?.signal("SIGSTOP");
  }

  unfreeze(id: string) {
    this.terminals.get(id)?.signal("SIGCONT");
  }

  interrupt(id: string) {
    this.terminals.get(id)?.interrupt();
  }

  ask(id: string, text: string) {
    this.terminals.get(id)?.inject(text);
  }
}
