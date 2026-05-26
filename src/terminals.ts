import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { createTerminal, killTerminal, termSocketUrl } from "./api.ts";

const COLS = 80;
const ROWS = 24;
const STORAGE_KEY = "isotop.terminals";
const PROBE_RANGE = 12;
const PROBE_TIMEOUT_MS = 1200;

type Pane = {
  id: string;
  root: HTMLDivElement;
  term: Terminal;
  fit: FitAddon;
  ws: WebSocket;
};

type TerminalsOptions = {
  host: HTMLElement;
  onOpened: (id: string) => void;
  onClosed: (id: string) => void;
  onList: (ids: string[], activeId: string | null) => void;
};

export class TerminalsUI {
  private panes = new Map<string, Pane>();
  private order: string[] = [];
  private activeId: string | null = null;

  constructor(private opts: TerminalsOptions) {
    window.addEventListener("resize", () => this.fitActive());
  }

  private fitActive(): void {
    if (!this.activeId) return;
    const pane = this.panes.get(this.activeId);
    if (pane) this.safeFit(pane);
  }

  private safeFit(pane: Pane): void {
    if (pane.root.style.display === "none") return;
    try {
      pane.fit.fit();
    } catch {
      /* container not measurable yet */
    }
  }

  async spawn(): Promise<void> {
    const id = await createTerminal();
    if (!id) return;
    this.order.push(id);
    this.saveOrder();
    this.opts.onOpened(id);
    this.createPane(id);
    this.setActive(id);
  }

  open(id: string): void {
    if (!this.panes.has(id)) this.createPane(id);
    this.setActive(id);
  }

  async restore(): Promise<void> {
    const candidates = new Set<string>(this.loadSaved());
    for (let i = 1; i <= PROBE_RANGE; i++) candidates.add(`t${i}`);
    const checked = await Promise.all(
      [...candidates].map(async (id) => ((await this.probe(id)) ? id : null)),
    );
    const alive = checked
      .filter((id): id is string => id !== null)
      .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
    this.order = alive;
    this.saveOrder();
    for (const id of alive) {
      this.opts.onOpened(id);
      this.createPane(id);
    }
    this.setActive(alive[0] ?? null);
  }

  private createPane(id: string): void {
    const root = document.createElement("div");
    root.style.cssText = "width:100%;height:100%";
    this.opts.host.appendChild(root);

    const term = new Terminal({
      cols: COLS,
      rows: ROWS,
      fontSize: 13,
      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
      cursorBlink: true,
      theme: {
        background: "#150d13",
        foreground: "#f0d4e0",
        cursor: "#ff9ec7",
        selectionBackground: "#5a3a4a",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(root);

    const pane: Pane = { id, root, term, fit, ws: new WebSocket(termSocketUrl(id)) };
    const ws = pane.ws;
    ws.addEventListener("message", (e) => term.write(e.data as string));
    term.onData((d) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(d);
    });
    ws.addEventListener("close", () => term.write("\r\n[disconnected]\r\n"));

    this.panes.set(id, pane);
    requestAnimationFrame(() => this.safeFit(pane));
  }

  private setActive(id: string | null): void {
    this.activeId = id;
    for (const pane of this.panes.values()) {
      pane.root.style.display = pane.id === id ? "block" : "none";
    }
    const active = id ? this.panes.get(id) : undefined;
    if (active) {
      // A pane can only be measured once it is the visible one.
      this.safeFit(active);
      active.term.focus();
    }
    this.emitList();
  }

  close(id: string): void {
    const pane = this.panes.get(id);
    if (pane) {
      pane.ws.close();
      pane.term.dispose();
      pane.root.remove();
      this.panes.delete(id);
    }
    this.order = this.order.filter((t) => t !== id);
    this.saveOrder();
    killTerminal(id);
    this.opts.onClosed(id);
    if (this.activeId === id) {
      this.setActive(this.order[this.order.length - 1] ?? null);
    } else {
      this.emitList();
    }
  }

  private emitList(): void {
    this.opts.onList([...this.order], this.activeId);
  }

  private probe(id: string): Promise<boolean> {
    return new Promise((resolve) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(termSocketUrl(id));
      } catch {
        resolve(false);
        return;
      }
      let settled = false;
      const finish = (alive: boolean) => {
        if (settled) return;
        settled = true;
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        resolve(alive);
      };
      ws.addEventListener("open", () => finish(true));
      ws.addEventListener("error", () => finish(false));
      ws.addEventListener("close", () => finish(false));
      setTimeout(() => finish(false), PROBE_TIMEOUT_MS);
    });
  }

  private loadSaved(): string[] {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const parsed = raw ? (JSON.parse(raw) as unknown) : [];
      return Array.isArray(parsed)
        ? parsed.filter((x): x is string => typeof x === "string")
        : [];
    } catch {
      return [];
    }
  }

  private saveOrder(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.order));
    } catch {
      /* ignore */
    }
  }
}
