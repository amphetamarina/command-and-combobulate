import * as pty from "node-pty";

const OUTPUT_BUFFER_CAP = 16384;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

export type TermClient = { send: (data: string) => void };

class Terminal {
  readonly id: string;
  readonly pid: number;
  private proc: pty.IPty;
  private buffer = "";
  private clients = new Set<TermClient>();

  constructor(id: string, cols: number, rows: number, onExit: () => void) {
    this.id = id;
    const shell = process.env.SHELL ?? "bash";
    this.proc = pty.spawn(shell, ["-i"], {
      name: "xterm-256color",
      cols,
      rows,
      cwd: process.env.HOME ?? process.cwd(),
      env: process.env as Record<string, string>,
    });
    this.pid = this.proc.pid;
    this.proc.onData((data) => {
      this.buffer = (this.buffer + data).slice(-OUTPUT_BUFFER_CAP);
      for (const client of this.clients) client.send(data);
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

  write(data: string) {
    this.proc.write(data);
  }

  resize(cols: number, rows: number) {
    if (cols > 0 && rows > 0) this.proc.resize(cols, rows);
  }

  kill() {
    try {
      this.proc.kill();
    } catch {
      // already gone
    }
  }
}

export class TerminalManager {
  private terminals = new Map<string, Terminal>();
  private seq = 0;

  create(cols = DEFAULT_COLS, rows = DEFAULT_ROWS): string {
    const id = `t${++this.seq}`;
    this.terminals.set(
      id,
      new Terminal(id, cols, rows, () => this.terminals.delete(id)),
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
}
