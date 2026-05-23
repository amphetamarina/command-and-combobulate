import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { createTerminal, killTerminal, termSocketUrl } from "./api.ts";

const COLS = 80;
const ROWS = 24;

type TermWindow = {
  id: string;
  root: HTMLDivElement;
  term: Terminal;
  ws: WebSocket;
  expanded: boolean;
};

type TerminalsOptions = {
  onOpened: (id: string) => void;
  onClosed: (id: string) => void;
  onList: (ids: string[]) => void;
};

export class TerminalsUI {
  private windows = new Map<string, TermWindow>();
  private active: string[] = [];
  private zTop = 60;
  private spawnOffset = 0;

  constructor(private opts: TerminalsOptions) {}

  async spawn(): Promise<void> {
    const id = await createTerminal();
    if (!id) return;
    this.active.push(id);
    this.opts.onOpened(id);
    this.opts.onList([...this.active]);
    this.openWindow(id);
  }

  open(id: string): void {
    const win = this.windows.get(id);
    if (win) {
      win.root.style.display = "flex";
      this.focus(win);
      return;
    }
    this.openWindow(id);
  }

  private focus(win: TermWindow): void {
    win.root.style.zIndex = String(++this.zTop);
  }

  private openWindow(id: string): void {
    const root = document.createElement("div");
    const offset = (this.spawnOffset++ % 6) * 28;
    root.style.cssText = [
      "position:fixed",
      `left:${120 + offset}px`,
      `top:${80 + offset}px`,
      "display:flex",
      "flex-direction:column",
      "background:#0b0b14",
      "border:1px solid #2c2c44",
      "border-radius:5px",
      "box-shadow:0 8px 32px rgba(0,0,0,0.6)",
      `z-index:${++this.zTop}`,
      "overflow:hidden",
      "font-family:ui-monospace,monospace",
    ].join(";");
    root.addEventListener("pointerdown", () => this.focus(win));

    const bar = document.createElement("div");
    bar.style.cssText = [
      "display:flex",
      "align-items:center",
      "gap:8px",
      "padding:5px 8px",
      "background:#1a1a28",
      "color:#cfcfe6",
      "font-size:12px",
      "cursor:move",
      "user-select:none",
    ].join(";");

    const title = document.createElement("span");
    title.textContent = `\u{1F5A5} ${id}`;
    title.style.flex = "1";

    const mkBtn = (label: string, color: string) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.style.cssText = [
        "width:20px",
        "height:18px",
        "line-height:1",
        "border:none",
        "border-radius:3px",
        "background:#2c2c44",
        `color:${color}`,
        "cursor:pointer",
        "font-family:inherit",
        "font-size:12px",
      ].join(";");
      return b;
    };
    const minBtn = mkBtn("–", "#cfcfe6");
    const expBtn = mkBtn("⛶", "#cfcfe6");
    const closeBtn = mkBtn("✕", "#ff8a7a");
    bar.append(title, minBtn, expBtn, closeBtn);

    const body = document.createElement("div");
    body.style.cssText = "padding:6px;background:#0b0b14;transform-origin:top left";

    const host = document.createElement("div");
    body.appendChild(host);
    root.append(bar, body);
    document.body.appendChild(root);

    const term = new Terminal({
      cols: COLS,
      rows: ROWS,
      fontSize: 13,
      cursorBlink: true,
      theme: { background: "#0b0b14", foreground: "#d8d8ec" },
    });
    term.open(host);
    term.focus();

    const ws = new WebSocket(termSocketUrl(id));
    ws.addEventListener("message", (e) => term.write(e.data as string));
    term.onData((d) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(d);
    });
    ws.addEventListener("close", () => term.write("\r\n[disconnected]\r\n"));

    const win: TermWindow = { id, root, term, ws, expanded: false };
    this.windows.set(id, win);

    this.makeDraggable(root, bar);
    minBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      root.style.display = "none";
    });
    expBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      win.expanded = !win.expanded;
      body.style.transform = win.expanded ? "scale(1.5)" : "scale(1)";
    });
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.close(id);
    });
  }

  private close(id: string): void {
    const win = this.windows.get(id);
    if (!win) return;
    win.ws.close();
    win.term.dispose();
    win.root.remove();
    this.windows.delete(id);
    this.active = this.active.filter((t) => t !== id);
    killTerminal(id);
    this.opts.onClosed(id);
    this.opts.onList([...this.active]);
  }

  private makeDraggable(root: HTMLDivElement, handle: HTMLElement): void {
    handle.addEventListener("pointerdown", (e) => {
      if ((e.target as HTMLElement).tagName === "BUTTON") return;
      const startX = e.clientX;
      const startY = e.clientY;
      const rect = root.getBoundingClientRect();
      const move = (ev: PointerEvent) => {
        root.style.left = `${rect.left + ev.clientX - startX}px`;
        root.style.top = `${rect.top + ev.clientY - startY}px`;
      };
      const up = () => {
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", up);
      };
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", up);
    });
  }
}
