import Phaser from "phaser";
import type { Region } from "../shared/types.ts";
import type {
  AgentSnapshot,
  FileEntry,
  FolderFiles,
  LiveMessage,
} from "../shared/proc-types.ts";
import { fetchFile, liveSocketUrl } from "./api.ts";
import { Sidebar, SIDEBAR_FRACTION } from "./sidebar.ts";
import { TerminalsUI } from "./terminals.ts";
import {
  drawIslandSides,
  drawIslandEdges,
  drawIslandTop,
  drawCable,
  regionCenter,
} from "./ground.ts";
import { TILE_H, tileToScreen } from "./iso.ts";
import {
  ROBOT_COLS,
  ROBOT_FRAME_H,
  ROBOT_FRAME_W,
  ROBOT_KEYS,
  NAMED_ROBOTS,
  SHEET_ROW_DIRS,
  WANDER_OFFSETS,
  headingFromScreen,
  npcHome,
  robotForExe,
  robotTextureKey,
  rowForHeading,
  type RobotKey,
} from "./npc.ts";

const GROUND_DEPTH = -20;
const LINK_DEPTH = -19.5;
const TOP_DEPTH = -19;
const EDGE_DEPTH = -18;
const LABEL_DEPTH = 100000;
const TERMINAL_LABEL_COLOR = "#ffd0e6";
const WORK_LABEL_COLOR = "#ecc8d8";
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.15;
const WS_RECONNECT_MS = 2000;
const WANDER_MIN_MS = 1500;
const WANDER_MAX_MS = 3500;
const WANDER_STAGGER_MS = 2000;
const COMMUTE_MS = 1400;
const WORK_MS = 1800;
const SUBAGENT_SCALE = 0.66;
const FILE_SCALE = 0.46;
const STACK_SCALE = 0.52;
const READ_COLOR = "#6bd6ff";
const WRITE_COLOR = "#ffae5a";
const RUN_COLOR = "#d7b8ff";

type NpcState = {
  container: Phaser.GameObjects.Container;
  mech: Phaser.GameObjects.Sprite;
  robotTex: string;
  baseScale: number;
  heading: (typeof SHEET_ROW_DIRS)[number];
  badge: Phaser.GameObjects.Text;
  homeTile: { x: number; y: number };
  currentTile: { x: number; y: number };
  latest: AgentSnapshot;
  busy: boolean;
  workingDir: string | null;
  tripId: number;
};

type CitySceneData = { regions: Region[] };

function formatRegionLabel(path: string): string {
  const home = path.replace(/^\/home\/[^/]+/, "~").replace(/^\/root/, "~");
  return home.length > 40 ? `…${home.slice(-39)}` : home;
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

// Stable small integer from an agent id, for the home-tile slot and art pick.
function hashId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function robotAssetUrl(key: RobotKey): string {
  if ((NAMED_ROBOTS as readonly string[]).includes(key)) {
    return `/isotop-assets/sci-fi/units/Robots/Spritesheets/${key}-8dir-walk-hover.png`;
  }
  return `/isotop-assets/sci-fi/units/Mech/Spritesheets/${key}-8dir-walk-hover.png`;
}

export class CityScene extends Phaser.Scene {
  private regions: Region[] = [];
  private regionByPath = new Map<string, Region>();
  private npcs = new Map<string, NpcState>();
  private sidesGraphics: Phaser.GameObjects.Graphics | null = null;
  private linksGraphics: Phaser.GameObjects.Graphics | null = null;
  private topGraphics: Phaser.GameObjects.Graphics | null = null;
  private edgesGraphics: Phaser.GameObjects.Graphics | null = null;
  private regionLabels: Phaser.GameObjects.Text[] = [];
  private terminalIcons: Phaser.GameObjects.Sprite[] = [];
  private fileSprites = new Map<
    string,
    { sprite: Phaser.GameObjects.Sprite; kind: string }
  >();
  private fileMeta = new Map<string, FileEntry>();
  private stackCounts = new Map<string, number>();
  private tooltip: HTMLDivElement | null = null;
  private modal: HTMLDivElement | null = null;
  private modalMode: "file" | "agent" | null = null;
  private openAgentId: string | null = null;
  private dragging = false;
  private sidebar: Sidebar | null = null;
  private terminals: TerminalsUI | null = null;

  constructor() {
    super("city");
  }

  init(data: CitySceneData) {
    this.regions = data.regions ?? [];
  }

  preload() {
    for (const key of ROBOT_KEYS) {
      this.load.spritesheet(robotTextureKey(key), robotAssetUrl(key), {
        frameWidth: ROBOT_FRAME_W,
        frameHeight: ROBOT_FRAME_H,
      });
    }
    this.load.spritesheet(
      "icon/terminal-flash",
      "/isotop-assets/sci-fi/icons/Spritesheets/terminal-typing-flash-8frame.png",
      { frameWidth: 128, frameHeight: 128 },
    );
    this.load.image("icon/file", "/isotop-assets/sci-fi/icons/file.png");
    this.load.image("icon/file-stack", "/isotop-assets/sci-fi/icons/file-stack.png");
    this.load.spritesheet(
      "icon/file-writing",
      "/isotop-assets/sci-fi/icons/Spritesheets/file-writing-8frame.png",
      { frameWidth: 128, frameHeight: 128 },
    );
  }

  create() {
    this.applyCameraViewport();
    this.scale.on("resize", () => this.applyCameraViewport());

    this.createRobotAnims();
    this.createTerminalAnim();
    this.sidesGraphics = this.add.graphics().setDepth(GROUND_DEPTH);
    this.linksGraphics = this.add.graphics().setDepth(LINK_DEPTH);
    this.topGraphics = this.add.graphics().setDepth(TOP_DEPTH);
    this.edgesGraphics = this.add.graphics().setDepth(EDGE_DEPTH);
    this.renderRegions();
    this.recenterCamera();

    this.sidebar = new Sidebar({
      onBuildTerminal: () => void this.terminals?.spawn(),
    });
    this.terminals = new TerminalsUI({
      host: this.sidebar.terminalHost,
      onOpened: () => {},
      onClosed: () => {},
      onList: (ids, active) =>
        this.sidebar?.setTerminals(
          ids,
          active,
          (id) => this.terminals?.open(id),
          (id) => this.terminals?.close(id),
        ),
    });
    void this.terminals.restore();

    this.tooltip = this.createTooltip();
    this.setupPan();
    this.setupZoom();
    this.setupTooltipFollow();
    this.startLiveSocket();
  }

  private applyCameraViewport() {
    const sw = Math.round(this.scale.width * SIDEBAR_FRACTION);
    this.cameras.main.setViewport(
      sw,
      0,
      Math.max(1, this.scale.width - sw),
      this.scale.height,
    );
  }

  private recenterCamera() {
    if (this.regions.length === 0) {
      this.cameras.main.centerOn(0, TILE_H * 2);
      return;
    }
    let sx = 0;
    let sy = 0;
    for (const r of this.regions) {
      const c = regionCenter(r);
      sx += c.x;
      sy += c.y;
    }
    this.cameras.main.centerOn(sx / this.regions.length, sy / this.regions.length);
  }

  private createRobotAnims() {
    for (const key of ROBOT_KEYS) {
      const tex = robotTextureKey(key);
      for (let row = 0; row < SHEET_ROW_DIRS.length; row++) {
        const start = row * ROBOT_COLS;
        this.anims.create({
          key: `${tex}/${row}`,
          frames: this.anims.generateFrameNumbers(tex, {
            start,
            end: start + ROBOT_COLS - 1,
          }),
          frameRate: 8,
          repeat: -1,
        });
      }
    }
  }

  private createTerminalAnim() {
    this.anims.create({
      key: "terminal-flash",
      frames: this.anims.generateFrameNumbers("icon/terminal-flash", {
        start: 0,
        end: 7,
      }),
      frameRate: 6,
      repeat: -1,
    });
    this.anims.create({
      key: "file-writing",
      frames: this.anims.generateFrameNumbers("icon/file-writing", {
        start: 0,
        end: 7,
      }),
      frameRate: 8,
      repeat: -1,
    });
  }

  private renderRegions() {
    if (
      !this.sidesGraphics ||
      !this.edgesGraphics ||
      !this.linksGraphics ||
      !this.topGraphics
    ) {
      return;
    }
    this.sidesGraphics.clear();
    this.topGraphics.clear();
    this.edgesGraphics.clear();
    for (const label of this.regionLabels) label.destroy();
    for (const icon of this.terminalIcons) icon.destroy();
    this.regionLabels = [];
    this.terminalIcons = [];
    this.regionByPath = new Map(this.regions.map((r) => [r.path, r]));

    // Parents before children so a child island paints over its parent's
    // surface (nesting), then by screen position for stable ordering.
    const ordered = [...this.regions].sort(
      (a, b) =>
        a.level - b.level ||
        a.origin.x + a.origin.y - (b.origin.x + b.origin.y),
    );
    for (const r of ordered) {
      drawIslandSides(this.sidesGraphics, r);
      drawIslandTop(this.topGraphics, r);
      drawIslandEdges(this.edgesGraphics, r);

      const isTerminal = r.kind === "terminal";
      if (isTerminal) {
        const c = regionCenter(r);
        const sum = r.origin.x + r.size.w / 2 + (r.origin.y + r.size.h / 2);
        const icon = this.add
          .sprite(c.x, c.y, "icon/terminal-flash")
          .setOrigin(0.5, 0.82)
          .setDepth(sum);
        icon.play("terminal-flash");
        this.terminalIcons.push(icon);
      }
      const corner = tileToScreen(r.origin.x, r.origin.y);
      const label = this.add
        .text(corner.x, corner.y - 4, formatRegionLabel(r.label), {
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          fontSize: "13px",
          color: isTerminal ? TERMINAL_LABEL_COLOR : WORK_LABEL_COLOR,
          fontStyle: isTerminal ? "normal" : "italic",
        })
        .setOrigin(0.5, 1)
        .setDepth(LABEL_DEPTH);
      this.regionLabels.push(label);
    }
  }

  // A cable from each terminal island to every folder island an agent on it
  // is currently working in.
  // The top-level (level 0) folder island that contains this dir, for cabling.
  private rootRegionFor(dir: string): Region | undefined {
    for (const r of this.regions) {
      if (r.kind !== "work" || r.level !== 0) continue;
      if (dir === r.path || dir.startsWith(`${r.path}/`)) return r;
    }
    return undefined;
  }

  private drawCables(agents: AgentSnapshot[]) {
    if (!this.linksGraphics) return;
    this.linksGraphics.clear();
    const drawn = new Set<string>();
    for (const a of agents) {
      if (!a.terminal || !a.activity) continue;
      const term = this.regionByPath.get(a.terminal);
      const root = this.rootRegionFor(a.activity.dir);
      if (!term || !root) continue;
      const key = `${a.terminal}->${root.path}`;
      if (drawn.has(key)) continue;
      drawn.add(key);
      drawCable(this.linksGraphics, regionCenter(term), regionCenter(root));
    }
  }

  // Render file icons on each folder island, one per file an agent touched,
  // collapsing the overflow into a stack icon when an island fills up.
  private updateFiles(folders: FolderFiles[]) {
    type Want = {
      x: number;
      y: number;
      depth: number;
      kind: "read" | "write" | "stack";
      path?: string;
    };
    const desired = new Map<string, Want>();
    this.fileMeta.clear();
    this.stackCounts.clear();

    for (const f of folders) {
      const region = this.regionByPath.get(f.dir);
      if (!region) continue;
      const fa = region.fileArea;
      const cols = Math.max(1, fa.cols);
      const maxSlots = cols * Math.max(1, fa.rows);
      const slot = (i: number) => {
        const tx = fa.x + (i % cols);
        const ty = fa.y + Math.floor(i / cols);
        const s = tileToScreen(tx, ty);
        return { x: s.x, y: s.y + TILE_H / 2, depth: tx + ty + 0.3 };
      };
      const individual =
        f.entries.length <= maxSlots ? f.entries.length : maxSlots - 1;
      for (let i = 0; i < individual; i++) {
        const e = f.entries[i]!;
        this.fileMeta.set(e.path, e);
        desired.set(e.path, { ...slot(i), kind: e.direction, path: e.path });
      }
      if (f.entries.length > maxSlots) {
        this.stackCounts.set(f.dir, f.entries.length - (maxSlots - 1));
        desired.set(`stack:${f.dir}`, { ...slot(maxSlots - 1), kind: "stack" });
      }
    }

    for (const [key, fs] of this.fileSprites) {
      if (!desired.has(key)) {
        fs.sprite.destroy();
        this.fileSprites.delete(key);
      }
    }
    for (const [key, d] of desired) {
      let fs = this.fileSprites.get(key);
      if (!fs) {
        const sprite = this.add
          .sprite(d.x, d.y, "icon/file")
          .setOrigin(0.5, 0.9);
        sprite.setInteractive({ pixelPerfect: true });
        sprite.on("pointerout", () => this.hideTooltip());
        if (d.kind === "stack") {
          const dir = key.slice("stack:".length);
          sprite.on("pointerover", () =>
            this.showText(`${this.stackCounts.get(dir) ?? 0} more files`),
          );
        } else {
          const path = d.path!;
          sprite.on("pointerover", () => this.showFileTooltip(path));
          sprite.on("pointerup", (p: Phaser.Input.Pointer) => {
            if (p.getDistance() < 8) void this.openFileModal(path);
          });
        }
        fs = { sprite, kind: "" };
        this.fileSprites.set(key, fs);
      }
      fs.sprite.setPosition(d.x, d.y).setDepth(d.depth);
      if (fs.kind !== d.kind) {
        fs.kind = d.kind;
        if (d.kind === "write") {
          fs.sprite.play("file-writing", true);
          fs.sprite.setScale(FILE_SCALE);
        } else {
          fs.sprite.stop();
          fs.sprite.setTexture(
            d.kind === "stack" ? "icon/file-stack" : "icon/file",
          );
          fs.sprite.setScale(d.kind === "stack" ? STACK_SCALE : FILE_SCALE);
        }
      }
    }
  }

  private showFileTooltip(path: string) {
    const e = this.fileMeta.get(path);
    if (!e) return;
    this.showText(`${e.name}\n${e.direction} · ${formatSize(e.size)}`);
  }

  private showText(text: string) {
    if (this.dragging || !this.tooltip) return;
    this.tooltip.textContent = text;
    this.tooltip.style.display = "block";
  }

  private openAgentModal(a: AgentSnapshot) {
    const modal = this.ensureModal();
    this.modalMode = "agent";
    this.openAgentId = a.id;
    (modal.querySelector(".aiso-title") as HTMLElement).textContent =
      `${a.label} — now`;
    this.fillAgentBody(a);
    modal.style.display = "flex";
  }

  private fillAgentBody(a: AgentSnapshot) {
    if (!this.modal) return;
    const body = this.modal.querySelector(".aiso-body") as HTMLElement;
    const now = a.activity
      ? `▶ ${a.activity.direction} ${a.activity.dir}`
      : "▶ idle";
    const lines = a.recent.length ? a.recent : ["(no actions yet)"];
    body.textContent = `${now}\n\nrecent:\n${lines.map((l) => `  ${l}`).join("\n")}`;
  }

  private async openFileModal(path: string) {
    const modal = this.ensureModal();
    this.modalMode = "file";
    this.openAgentId = null;
    const title = modal.querySelector(".aiso-title") as HTMLElement;
    const body = modal.querySelector(".aiso-body") as HTMLElement;
    title.textContent = path.split("/").pop() ?? path;
    body.textContent = "loading…";
    modal.style.display = "flex";
    try {
      const fc = await fetchFile(path);
      title.textContent = `${fc.name}  ·  ${formatSize(fc.size)}${fc.truncated ? "  · truncated" : ""}`;
      body.textContent = fc.content;
    } catch (err) {
      body.textContent = `failed to load: ${(err as Error).message}`;
    }
  }

  private ensureModal(): HTMLDivElement {
    if (this.modal) return this.modal;
    const overlay = document.createElement("div");
    overlay.style.cssText = [
      "position:fixed",
      "inset:0",
      "display:none",
      "align-items:center",
      "justify-content:center",
      "background:rgba(14,9,15,0.6)",
      "z-index:10000",
    ].join(";");
    const box = document.createElement("div");
    box.style.cssText = [
      "display:flex",
      "flex-direction:column",
      "width:min(70vw,820px)",
      "height:min(72vh,640px)",
      "background:#1a0f16",
      "border:1px solid #8a4a6a",
      "border-radius:8px",
      "box-shadow:0 8px 40px rgba(0,0,0,0.6)",
      "overflow:hidden",
    ].join(";");
    const header = document.createElement("div");
    header.style.cssText = [
      "display:flex",
      "align-items:center",
      "justify-content:space-between",
      "gap:12px",
      "padding:10px 14px",
      "background:#241620",
      "border-bottom:1px solid #4a2e3e",
      "font-family:'JetBrains Mono',ui-monospace,monospace",
      "color:#ffd0e6",
      "font-size:13px",
    ].join(";");
    const title = document.createElement("span");
    title.className = "aiso-title";
    const close = document.createElement("button");
    close.textContent = "×";
    close.style.cssText = [
      "background:none",
      "border:none",
      "color:#ff8aa8",
      "font-size:20px",
      "line-height:1",
      "cursor:pointer",
    ].join(";");
    close.addEventListener("click", () => (overlay.style.display = "none"));
    header.append(title, close);
    const body = document.createElement("pre");
    body.className = "aiso-body";
    body.style.cssText = [
      "margin:0",
      "padding:14px",
      "overflow:auto",
      "flex:1",
      "white-space:pre",
      "font-family:'JetBrains Mono',ui-monospace,monospace",
      "font-size:12px",
      "line-height:1.5",
      "color:#e9d6e0",
    ].join(";");
    box.append(header, body);
    overlay.append(box);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.style.display = "none";
    });
    document.body.appendChild(overlay);
    this.modal = overlay;
    return overlay;
  }

  private startLiveSocket() {
    let lastCount = -1;
    const connect = () => {
      const ws = new WebSocket(liveSocketUrl());
      ws.addEventListener("message", (ev) => {
        let msg: LiveMessage;
        try {
          msg = JSON.parse(ev.data) as LiveMessage;
        } catch (err) {
          console.warn(`[ws] bad message: ${(err as Error).message}`);
          return;
        }
        if (msg.kind === "agents") {
          this.updateNpcs(msg.agents);
          if (msg.agents.length !== lastCount) {
            console.log(
              `[ws] agents: ${msg.agents.length}, ${this.npcs.size} robots on screen`,
            );
            lastCount = msg.agents.length;
          }
        } else if (msg.kind === "world-delta") {
          this.regions = msg.regions;
          this.renderRegions();
          console.log(`[ws] ${msg.regions.length} islands`);
        } else if (msg.kind === "files") {
          this.updateFiles(msg.files);
        }
      });
      ws.addEventListener("close", () => {
        console.warn(`[ws] disconnected, retrying in ${WS_RECONNECT_MS}ms`);
        this.time.delayedCall(WS_RECONNECT_MS, connect);
      });
      ws.addEventListener("error", () => {
        ws.close();
      });
    };
    connect();
  }

  updateNpcs(agents: AgentSnapshot[]) {
    const seen = new Set<string>();
    for (const a of agents) {
      seen.add(a.id);
      const existing = this.npcs.get(a.id);
      if (existing) {
        existing.latest = a;
        this.handleActivity(existing);
        continue;
      }
      const home = a.terminal ? this.regionByPath.get(a.terminal) : undefined;
      if (!home) continue;
      const state = this.createNpc(a, home);
      this.npcs.set(a.id, state);
      this.scheduleWander(state);
      this.handleActivity(state);
    }
    for (const [id, state] of this.npcs) {
      if (!seen.has(id)) {
        state.container.destroy();
        this.npcs.delete(id);
      }
    }
    this.drawCables(agents);

    // Keep an open "what is this agent doing now" panel live.
    if (
      this.modalMode === "agent" &&
      this.openAgentId &&
      this.modal &&
      this.modal.style.display !== "none"
    ) {
      const a = agents.find((x) => x.id === this.openAgentId);
      if (a) this.fillAgentBody(a);
    }
  }

  private createNpc(a: AgentSnapshot, home: Region): NpcState {
    const hid = hashId(a.id);
    const spawn = npcHome(hid, home);
    const robotTex = robotTextureKey(robotForExe(a.tool, hid));
    const baseScale = a.kind === "subagent" ? SUBAGENT_SCALE : 1;
    const mech = this.add
      .sprite(0, 0, robotTex)
      .setOrigin(0.5, 1)
      .setScale(baseScale);
    mech.setFrame(rowForHeading("S") * ROBOT_COLS);
    mech.setInteractive({ pixelPerfect: true });
    mech.on("pointerover", () => this.showAgentTooltip(state.latest));
    mech.on("pointerout", () => this.hideTooltip());
    mech.on("pointerup", (p: Phaser.Input.Pointer) => {
      if (p.getDistance() < 8) this.openAgentModal(state.latest);
    });

    const top = -mech.displayHeight;
    const label = this.add
      .text(0, top - 4, a.label, {
        fontFamily: "ui-monospace, monospace",
        fontSize: "10px",
        color: "#ffe0ee",
        stroke: "#1a0f16",
        strokeThickness: 3,
      })
      .setOrigin(0.5, 1);
    const badge = this.add
      .text(0, top - 16, "", {
        fontFamily: "ui-monospace, monospace",
        fontSize: "10px",
        color: READ_COLOR,
        stroke: "#1a0f16",
        strokeThickness: 3,
      })
      .setOrigin(0.5, 1)
      .setVisible(false);

    const container = this.add.container(spawn.screen.x, spawn.screen.y, [
      mech,
      label,
      badge,
    ]);
    container.setDepth(spawn.tileSum + 0.5);

    const state: NpcState = {
      container,
      mech,
      robotTex,
      baseScale,
      heading: "S",
      badge,
      homeTile: spawn.tile,
      currentTile: spawn.tile,
      latest: a,
      busy: false,
      workingDir: null,
      tripId: 0,
    };
    return state;
  }

  private npcScreen(tile: { x: number; y: number }) {
    const s = tileToScreen(tile.x, tile.y);
    return { x: s.x, y: s.y + TILE_H / 2 };
  }

  private faceAndWalk(
    state: NpcState,
    from: { x: number; y: number },
    to: { x: number; y: number },
  ) {
    state.heading = headingFromScreen(to.x - from.x, to.y - from.y);
    state.mech.play(`${state.robotTex}/${rowForHeading(state.heading)}`, true);
  }

  private standStill(state: NpcState) {
    state.mech.stop();
    state.mech.setFrame(rowForHeading(state.heading) * ROBOT_COLS);
  }

  private handleActivity(state: NpcState) {
    const act = state.latest.activity;
    if (!act) return;
    if (state.workingDir === act.dir) return;
    const region = this.regionByPath.get(act.dir);
    if (!region) return;

    this.tweens.killTweensOf(state.container);
    state.busy = true;
    state.workingDir = act.dir;
    const trip = ++state.tripId;
    const beat =
      act.direction === "read"
        ? { text: "▼ read", color: READ_COLOR }
        : act.direction === "run"
          ? { text: "⚙ run", color: RUN_COLOR }
          : { text: "▲ write", color: WRITE_COLOR };
    state.badge.setText(beat.text);
    state.badge.setColor(beat.color);
    state.badge.setVisible(true);

    const center = {
      x: region.origin.x + region.size.w / 2,
      y: region.origin.y + region.size.h / 2,
    };
    this.travelTo(state, center, () => {
      if (trip !== state.tripId) return;
      this.workInPlace(state);
      this.time.delayedCall(WORK_MS, () => {
        if (trip !== state.tripId) return;
        this.returnHome(state, trip);
      });
    });
  }

  private travelTo(
    state: NpcState,
    tile: { x: number; y: number },
    onArrive: () => void,
  ) {
    const start = { x: state.currentTile.x, y: state.currentTile.y };
    const dest = this.npcScreen(tile);
    this.faceAndWalk(state, { x: state.container.x, y: state.container.y }, dest);
    this.tweens.add({
      targets: state.container,
      x: dest.x,
      y: dest.y,
      duration: COMMUTE_MS,
      ease: "Sine.easeInOut",
      onUpdate: (tween) => {
        const p = tween.progress;
        const cx = start.x + (tile.x - start.x) * p;
        const cy = start.y + (tile.y - start.y) * p;
        state.container.setDepth(cx + cy + 0.5);
      },
      onComplete: () => {
        state.currentTile = { x: tile.x, y: tile.y };
        state.container.setDepth(tile.x + tile.y + 0.5);
        this.standStill(state);
        onArrive();
      },
    });
  }

  private workInPlace(state: NpcState) {
    this.standStill(state);
    this.tweens.add({
      targets: state.mech,
      scaleY: state.baseScale * 0.9,
      duration: WORK_MS / 6,
      ease: "Sine.easeInOut",
      yoyo: true,
      repeat: 2,
    });
  }

  private returnHome(state: NpcState, trip: number) {
    this.travelTo(state, state.homeTile, () => {
      if (trip !== state.tripId) return;
      state.busy = false;
      state.workingDir = null;
      state.badge.setVisible(false);
      this.tweens.killTweensOf(state.mech);
      state.mech.setScale(state.baseScale);
      this.wanderOnce(state);
    });
  }

  private scheduleWander(state: NpcState) {
    this.time.delayedCall(Math.random() * WANDER_STAGGER_MS, () =>
      this.wanderOnce(state),
    );
  }

  private wanderOnce(state: NpcState) {
    if (!state.container.active || state.busy) return;
    const off =
      WANDER_OFFSETS[Math.floor(Math.random() * WANDER_OFFSETS.length)]!;
    const targetTile = {
      x: state.homeTile.x + off.x,
      y: state.homeTile.y + off.y,
    };
    const targetScreen = tileToScreen(targetTile.x, targetTile.y);
    const dest = { x: targetScreen.x, y: targetScreen.y + TILE_H / 2 };
    const startTile = { x: state.currentTile.x, y: state.currentTile.y };
    this.faceAndWalk(state, { x: state.container.x, y: state.container.y }, dest);
    this.tweens.add({
      targets: state.container,
      x: dest.x,
      y: dest.y,
      duration: WANDER_MIN_MS + Math.random() * (WANDER_MAX_MS - WANDER_MIN_MS),
      ease: "Sine.easeInOut",
      onUpdate: (tween) => {
        const p = tween.progress;
        const cx = startTile.x + (targetTile.x - startTile.x) * p;
        const cy = startTile.y + (targetTile.y - startTile.y) * p;
        state.container.setDepth(cx + cy + 0.5);
      },
      onComplete: () => {
        state.currentTile = targetTile;
        state.container.setDepth(targetTile.x + targetTile.y + 0.5);
        this.wanderOnce(state);
      },
    });
  }

  private createTooltip(): HTMLDivElement {
    const el = document.createElement("div");
    el.style.cssText = [
      "position:fixed",
      "pointer-events:none",
      "display:none",
      "background:#1a1a28",
      "color:#e0e0f0",
      "border:1px solid #ff9ec7",
      "padding:8px 10px",
      "font-family:ui-monospace,monospace",
      "font-size:12px",
      "line-height:1.45",
      "border-radius:4px",
      "z-index:9999",
      "max-width:480px",
      "white-space:pre",
      "box-shadow:0 2px 12px rgba(0,0,0,0.6)",
    ].join(";");
    document.body.appendChild(el);
    return el;
  }

  private showAgentTooltip(a: AgentSnapshot) {
    if (this.dragging || !this.tooltip) return;
    const role = a.kind === "subagent" ? "subagent" : "agent";
    const doing = a.activity
      ? `${a.activity.direction}: ${a.activity.dir}`
      : "idle";
    this.tooltip.textContent = `${a.label} (${role})\ntool: ${a.tool}\n${doing}`;
    this.tooltip.style.display = "block";
  }

  private hideTooltip() {
    if (this.tooltip) this.tooltip.style.display = "none";
  }

  private setupTooltipFollow() {
    this.input.on("pointermove", (p: Phaser.Input.Pointer) => {
      if (!this.tooltip || this.tooltip.style.display !== "block") return;
      const rect = this.game.canvas.getBoundingClientRect();
      this.tooltip.style.left = `${rect.left + p.x + 14}px`;
      this.tooltip.style.top = `${rect.top + p.y + 14}px`;
    });
    this.events.on(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.tooltip?.remove();
      this.tooltip = null;
      this.modal?.remove();
      this.modal = null;
    });
  }

  private setupPan() {
    const drag = { x: 0, y: 0 };
    this.input.on("pointerdown", (p: Phaser.Input.Pointer) => {
      this.dragging = true;
      drag.x = p.x;
      drag.y = p.y;
      this.hideTooltip();
    });
    this.input.on("pointermove", (p: Phaser.Input.Pointer) => {
      if (!this.dragging) return;
      const cam = this.cameras.main;
      cam.scrollX -= (p.x - drag.x) / cam.zoom;
      cam.scrollY -= (p.y - drag.y) / cam.zoom;
      drag.x = p.x;
      drag.y = p.y;
    });
    const stop = () => {
      this.dragging = false;
    };
    this.input.on("pointerup", stop);
    this.input.on("pointerupoutside", stop);
  }

  private setupZoom() {
    this.input.on(
      "wheel",
      (
        _p: Phaser.Input.Pointer,
        _objs: unknown,
        _dx: number,
        dy: number,
      ) => {
        const cam = this.cameras.main;
        const next = Phaser.Math.Clamp(
          cam.zoom + (dy < 0 ? ZOOM_STEP : -ZOOM_STEP),
          MIN_ZOOM,
          MAX_ZOOM,
        );
        cam.zoom = next;
      },
    );
  }
}
