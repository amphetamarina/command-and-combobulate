export const SIDEBAR_W = 220;
const MINIMAP_SIZE = 196;
const PANEL_PAD = 12;

export type MinimapRegion = {
  x: number;
  y: number;
  w: number;
  h: number;
  tint: number;
  work: boolean;
};

export type MinimapBounds = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

export type MinimapStatic = {
  bounds: MinimapBounds;
  regions: MinimapRegion[];
  buildings: { x: number; y: number }[];
};

export type MinimapNpc = {
  x: number;
  y: number;
  selected: boolean;
  working: boolean;
};

export type MinimapView = { x: number; y: number; w: number; h: number };

export type SelectionInfo = {
  pid: number;
  comm: string;
  exe: string;
  cpu: number;
  mem: number;
  activity: { dir: string; direction: "read" | "write" } | null;
  alive: boolean;
};

type SidebarOptions = {
  onNavigate: (worldX: number, worldY: number) => void;
  onKill: (pid: number) => void;
  onBuildTerminal: () => void;
};

function hex(n: number): string {
  return `#${n.toString(16).padStart(6, "0")}`;
}

function row(label: string, value: string): HTMLDivElement {
  const el = document.createElement("div");
  el.style.cssText = "display:flex;gap:8px;margin:2px 0";
  const k = document.createElement("span");
  k.textContent = label;
  k.style.cssText = "color:#7a7a95;min-width:46px";
  const v = document.createElement("span");
  v.textContent = value;
  v.style.cssText = "color:#d8d8ec;word-break:break-all";
  el.append(k, v);
  return el;
}

export class Sidebar {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private detail: HTMLDivElement;
  private empty: HTMLDivElement;
  private termList!: HTMLDivElement;
  private termEmpty!: HTMLDivElement;
  private killBtn: HTMLButtonElement;
  private fields: HTMLDivElement;
  private commEl: HTMLDivElement;
  private selectedPid: number | null = null;
  private confirming = false;
  private confirmTimer: number | null = null;
  private staticLayer: HTMLCanvasElement;
  private bounds: MinimapBounds = { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  private scale = 1;
  private offX = 0;
  private offY = 0;

  constructor(private opts: SidebarOptions) {
    const root = document.createElement("div");
    root.style.cssText = [
      "position:fixed",
      "top:0",
      "right:0",
      `width:${SIDEBAR_W}px`,
      "height:100%",
      "box-sizing:border-box",
      `padding:${PANEL_PAD}px`,
      "background:linear-gradient(#15151f,#101019)",
      "border-left:2px solid #2c2c44",
      "box-shadow:-4px 0 16px rgba(0,0,0,0.5)",
      "font-family:'JetBrains Mono',ui-monospace,monospace",
      "color:#d8d8ec",
      "font-size:13px",
      "z-index:50",
      "user-select:none",
    ].join(";");

    const title = document.createElement("div");
    title.textContent = "ISOTOP";
    title.style.cssText =
      "letter-spacing:4px;font-size:17px;color:#6bb6ff;text-align:center;margin-bottom:10px";

    this.canvas = document.createElement("canvas");
    this.canvas.width = MINIMAP_SIZE;
    this.canvas.height = MINIMAP_SIZE;
    this.canvas.style.cssText = [
      "width:100%",
      "aspect-ratio:1/1",
      "display:block",
      "background:#0a0a12",
      "border:1px solid #2c2c44",
      "cursor:crosshair",
    ].join(";");
    this.ctx = this.canvas.getContext("2d")!;
    this.staticLayer = document.createElement("canvas");
    this.staticLayer.width = MINIMAP_SIZE;
    this.staticLayer.height = MINIMAP_SIZE;
    this.canvas.addEventListener("pointerdown", (e) => this.onMinimapClick(e));

    const buildSection = document.createElement("div");
    buildSection.style.cssText = "margin-top:14px";
    buildSection.append(this.sectionLabel("BUILD"));
    const termBtn = document.createElement("button");
    termBtn.style.cssText = [
      "display:flex",
      "align-items:center",
      "gap:10px",
      "width:100%",
      "padding:8px 10px",
      "background:#16263a",
      "color:#7fe0d0",
      "border:1px solid #2c4a5a",
      "border-radius:4px",
      "font-family:inherit",
      "font-size:13px",
      "text-align:left",
      "cursor:pointer",
    ].join(";");
    termBtn.append(this.icon(28), this.span("Terminal"));
    termBtn.addEventListener("click", () => this.opts.onBuildTerminal());
    buildSection.appendChild(termBtn);

    const termSection = document.createElement("div");
    termSection.style.cssText = "margin-top:14px";
    termSection.append(this.sectionLabel("TERMINALS"));
    this.termList = document.createElement("div");
    this.termList.style.cssText = "display:flex;flex-direction:column;gap:4px";
    this.termEmpty = document.createElement("div");
    this.termEmpty.textContent = "none running";
    this.termEmpty.style.cssText = "color:#5a5a78;font-size:12px";
    termSection.append(this.termList, this.termEmpty);

    this.empty = document.createElement("div");
    this.empty.textContent = "click a mech to inspect";
    this.empty.style.cssText = "color:#5a5a78;margin-top:14px;text-align:center";

    this.detail = document.createElement("div");
    this.detail.style.cssText = "margin-top:14px;display:none";
    this.commEl = document.createElement("div");
    this.commEl.style.cssText =
      "font-size:14px;color:#e6e6f2;margin-bottom:8px;word-break:break-all";
    this.fields = document.createElement("div");
    this.killBtn = document.createElement("button");
    this.killBtn.textContent = "KILL";
    this.killBtn.style.cssText = [
      "margin-top:12px",
      "width:100%",
      "padding:8px",
      "background:#3a1a1a",
      "color:#ff8a7a",
      "border:1px solid #7a3a3a",
      "border-radius:3px",
      "font-family:inherit",
      "font-size:13px",
      "letter-spacing:1px",
      "cursor:pointer",
    ].join(";");
    this.killBtn.addEventListener("click", () => this.onKillClick());
    this.detail.append(this.commEl, this.fields, this.killBtn);

    root.append(
      title,
      this.canvas,
      buildSection,
      termSection,
      this.empty,
      this.detail,
    );
    document.body.appendChild(root);
  }

  private sectionLabel(text: string): HTMLDivElement {
    const el = document.createElement("div");
    el.textContent = text;
    el.style.cssText =
      "color:#7a7a95;letter-spacing:2px;font-size:12px;margin-bottom:6px";
    return el;
  }

  private span(text: string): HTMLSpanElement {
    const el = document.createElement("span");
    el.textContent = text;
    return el;
  }

  private icon(size: number): HTMLImageElement {
    const img = document.createElement("img");
    img.src = "/isotop-assets/sci-fi/icons/terminal.png";
    img.width = size;
    img.height = size;
    img.style.cssText = "image-rendering:pixelated;flex:none";
    return img;
  }

  setTerminals(ids: string[], onOpen: (id: string) => void): void {
    this.termList.replaceChildren();
    this.termEmpty.style.display = ids.length ? "none" : "block";
    for (const id of ids) {
      const row = document.createElement("button");
      row.style.cssText = [
        "display:flex",
        "align-items:center",
        "gap:8px",
        "width:100%",
        "padding:5px 8px",
        "background:#15151f",
        "color:#cfcfe6",
        "border:1px solid #2c2c44",
        "border-radius:4px",
        "font-family:inherit",
        "font-size:13px",
        "text-align:left",
        "cursor:pointer",
      ].join(";");
      row.append(this.icon(18), this.span(id));
      row.addEventListener("click", () => onOpen(id));
      this.termList.appendChild(row);
    }
  }

  private px(x: number): number {
    return (x - this.bounds.minX) * this.scale + this.offX;
  }

  private py(y: number): number {
    return (y - this.bounds.minY) * this.scale + this.offY;
  }

  private onMinimapClick(e: PointerEvent) {
    const rect = this.canvas.getBoundingClientRect();
    const mx = ((e.clientX - rect.left) / rect.width) * MINIMAP_SIZE;
    const my = ((e.clientY - rect.top) / rect.height) * MINIMAP_SIZE;
    const worldX = (mx - this.offX) / this.scale + this.bounds.minX;
    const worldY = (my - this.offY) / this.scale + this.bounds.minY;
    this.opts.onNavigate(worldX, worldY);
  }

  setMinimapStatic(s: MinimapStatic) {
    this.bounds = s.bounds;
    const w = Math.max(1, s.bounds.maxX - s.bounds.minX);
    const h = Math.max(1, s.bounds.maxY - s.bounds.minY);
    const usable = MINIMAP_SIZE - 8;
    this.scale = Math.min(usable / w, usable / h);
    this.offX = (MINIMAP_SIZE - w * this.scale) / 2;
    this.offY = (MINIMAP_SIZE - h * this.scale) / 2;

    const ctx = this.staticLayer.getContext("2d")!;
    ctx.clearRect(0, 0, MINIMAP_SIZE, MINIMAP_SIZE);
    ctx.fillStyle = "#0a0a12";
    ctx.fillRect(0, 0, MINIMAP_SIZE, MINIMAP_SIZE);

    for (const r of s.regions) {
      ctx.fillStyle = hex(r.tint);
      ctx.globalAlpha = r.work ? 0.4 : 0.55;
      ctx.fillRect(this.px(r.x), this.py(r.y), r.w * this.scale, r.h * this.scale);
      ctx.globalAlpha = 1;
      if (r.work) {
        ctx.strokeStyle = "#7fe0d0";
        ctx.lineWidth = 1;
        ctx.strokeRect(this.px(r.x), this.py(r.y), r.w * this.scale, r.h * this.scale);
      }
    }

    ctx.fillStyle = "#b9b9d0";
    for (const b of s.buildings) {
      ctx.fillRect(this.px(b.x) - 1, this.py(b.y) - 1, 2, 2);
    }
  }

  drawMinimap(npcs: MinimapNpc[], view: MinimapView) {
    const { ctx } = this;
    ctx.clearRect(0, 0, MINIMAP_SIZE, MINIMAP_SIZE);
    ctx.drawImage(this.staticLayer, 0, 0);

    for (const n of npcs) {
      ctx.fillStyle = n.selected ? "#7fff7f" : n.working ? "#ffae5a" : "#6bb6ff";
      const s = n.selected ? 3 : 2;
      ctx.fillRect(this.px(n.x) - s / 2, this.py(n.y) - s / 2, s, s);
    }

    ctx.strokeStyle = "rgba(255,255,255,0.8)";
    ctx.lineWidth = 1;
    ctx.strokeRect(
      this.px(view.x),
      this.py(view.y),
      view.w * this.scale,
      view.h * this.scale,
    );
  }

  setSelection(info: SelectionInfo | null) {
    this.selectedPid = info && info.alive ? info.pid : null;
    this.resetConfirm();
    if (!info) {
      this.detail.style.display = "none";
      this.empty.style.display = "block";
      return;
    }
    this.empty.style.display = "none";
    this.detail.style.display = "block";
    this.commEl.textContent = info.alive
      ? info.comm
      : `${info.comm} (ended)`;
    this.fields.replaceChildren(
      row("pid", String(info.pid)),
      row("cpu", `${(info.cpu * 100).toFixed(0)}% core`),
      row("mem", `${(info.mem * 100).toFixed(1)}% ram`),
      row(
        "doing",
        info.activity
          ? `${info.activity.direction} ${info.activity.dir}`
          : "idle",
      ),
      row("exe", info.exe),
    );
    this.killBtn.disabled = !info.alive;
    this.killBtn.style.opacity = info.alive ? "1" : "0.4";
  }

  private onKillClick() {
    if (this.selectedPid === null) return;
    if (!this.confirming) {
      this.confirming = true;
      this.killBtn.textContent = "CONFIRM KILL";
      this.killBtn.style.background = "#7a2020";
      this.confirmTimer = window.setTimeout(() => this.resetConfirm(), 3000);
      return;
    }
    this.opts.onKill(this.selectedPid);
    this.resetConfirm();
  }

  private resetConfirm() {
    this.confirming = false;
    if (this.confirmTimer !== null) {
      clearTimeout(this.confirmTimer);
      this.confirmTimer = null;
    }
    this.killBtn.textContent = "KILL";
    this.killBtn.style.background = "#3a1a1a";
  }
}
