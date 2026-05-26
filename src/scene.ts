import Phaser from "phaser";
import type { Region } from "../shared/types.ts";
import type { LiveMessage, ProcessSnapshot } from "../shared/proc-types.ts";
import { liveSocketUrl } from "./api.ts";
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
  NAMED_ROBOTS,
  ROBOT_COLS,
  ROBOT_FRAME_H,
  ROBOT_FRAME_W,
  ROBOT_KEYS,
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
const BAR_W = 26;
const BAR_H = 3;
const BAR_TRACK_COLOR = 0x14141e;
const MEM_BAR_COLOR = 0x4aa6ff;
const MEM_BAR_FULL = 0.2;
const COMMUTE_MS = 1400;
const WORK_MS = 1800;
const READ_COLOR = "#6bd6ff";
const WRITE_COLOR = "#ffae5a";

type NpcState = {
  container: Phaser.GameObjects.Container;
  mech: Phaser.GameObjects.Sprite;
  robotTex: string;
  heading: (typeof SHEET_ROW_DIRS)[number];
  cpuFill: Phaser.GameObjects.Rectangle;
  memFill: Phaser.GameObjects.Rectangle;
  badge: Phaser.GameObjects.Text;
  homeTile: { x: number; y: number };
  currentTile: { x: number; y: number };
  latest: ProcessSnapshot;
  busy: boolean;
  workingDir: string | null;
  tripId: number;
};

type CitySceneData = { regions: Region[] };

function formatRegionLabel(path: string): string {
  const home = path.replace(/^\/home\/[^/]+/, "~").replace(/^\/root/, "~");
  return home.length > 40 ? `…${home.slice(-39)}` : home;
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function cpuBarColor(cpu: number): number {
  if (cpu < 0.5) return 0x4ad66a;
  if (cpu < 0.8) return 0xe0c84a;
  return 0xe05a4a;
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
  private npcs = new Map<number, NpcState>();
  private sidesGraphics: Phaser.GameObjects.Graphics | null = null;
  private linksGraphics: Phaser.GameObjects.Graphics | null = null;
  private topGraphics: Phaser.GameObjects.Graphics | null = null;
  private edgesGraphics: Phaser.GameObjects.Graphics | null = null;
  private regionLabels: Phaser.GameObjects.Text[] = [];
  private tooltip: HTMLDivElement | null = null;
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
  }

  create() {
    this.applyCameraViewport();
    this.scale.on("resize", () => this.applyCameraViewport());

    this.createRobotAnims();
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
    this.regionLabels = [];
    this.regionByPath = new Map(this.regions.map((r) => [r.path, r]));

    const ordered = [...this.regions].sort(
      (a, b) => a.origin.x + a.origin.y - (b.origin.x + b.origin.y),
    );
    for (const r of ordered) {
      drawIslandSides(this.sidesGraphics, r);
      drawIslandTop(this.topGraphics, r);
      drawIslandEdges(this.edgesGraphics, r);

      const isTerminal = r.kind === "terminal";
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

  // A cable from each terminal island to every folder island its processes
  // are currently touching.
  private drawCables(processes: ProcessSnapshot[]) {
    if (!this.linksGraphics) return;
    this.linksGraphics.clear();
    const drawn = new Set<string>();
    for (const p of processes) {
      if (!p.terminal || !p.activity) continue;
      const key = `${p.terminal}->${p.activity.dir}`;
      if (drawn.has(key)) continue;
      const term = this.regionByPath.get(p.terminal);
      const work = this.regionByPath.get(p.activity.dir);
      if (!term || !work) continue;
      drawn.add(key);
      drawCable(this.linksGraphics, regionCenter(term), regionCenter(work));
    }
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
        if (msg.kind === "procs") {
          this.updateNpcs(msg.processes);
          if (msg.processes.length !== lastCount) {
            console.log(
              `[ws] procs: ${msg.processes.length} processes, ${this.npcs.size} npcs on screen`,
            );
            lastCount = msg.processes.length;
          }
        } else if (msg.kind === "world-delta") {
          this.regions = msg.regions;
          this.renderRegions();
          console.log(`[ws] ${msg.regions.length} islands`);
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

  updateNpcs(processes: ProcessSnapshot[]) {
    const seen = new Set<number>();
    for (const p of processes) {
      seen.add(p.pid);
      const existing = this.npcs.get(p.pid);
      if (existing) {
        this.applyUsage(existing, p);
        this.handleActivity(existing);
        continue;
      }
      const home = p.terminal ? this.regionByPath.get(p.terminal) : undefined;
      if (!home) continue;
      const state = this.createNpc(p, home);
      this.npcs.set(p.pid, state);
      this.scheduleWander(state);
      this.handleActivity(state);
    }
    for (const [pid, state] of this.npcs) {
      if (!seen.has(pid)) {
        state.container.destroy();
        this.npcs.delete(pid);
      }
    }
    this.drawCables(processes);
  }

  private createNpc(p: ProcessSnapshot, home: Region): NpcState {
    const spawn = npcHome(p.pid, home);
    const robotTex = robotTextureKey(robotForExe(p.exe, p.pid));
    const mech = this.add.sprite(0, 0, robotTex).setOrigin(0.5, 1);
    mech.setFrame(rowForHeading("S") * ROBOT_COLS);
    mech.setInteractive({ pixelPerfect: true });
    mech.on("pointerover", () => this.showProcTooltip(state.latest));
    mech.on("pointerout", () => this.hideTooltip());

    const top = -mech.displayHeight;
    const left = -BAR_W / 2;
    const cpuTrack = this.add
      .rectangle(left, top - 6, BAR_W, BAR_H, BAR_TRACK_COLOR)
      .setOrigin(0, 0.5);
    const cpuFill = this.add
      .rectangle(left, top - 6, BAR_W, BAR_H, cpuBarColor(p.cpu))
      .setOrigin(0, 0.5);
    const memTrack = this.add
      .rectangle(left, top - 11, BAR_W, BAR_H, BAR_TRACK_COLOR)
      .setOrigin(0, 0.5);
    const memFill = this.add
      .rectangle(left, top - 11, BAR_W, BAR_H, MEM_BAR_COLOR)
      .setOrigin(0, 0.5);
    const label = this.add
      .text(0, top - 14, p.comm, {
        fontFamily: "ui-monospace, monospace",
        fontSize: "10px",
        color: "#e6e6f2",
        stroke: "#0a0a12",
        strokeThickness: 3,
      })
      .setOrigin(0.5, 1);
    const badge = this.add
      .text(0, top - 24, "", {
        fontFamily: "ui-monospace, monospace",
        fontSize: "10px",
        color: READ_COLOR,
        stroke: "#0a0a12",
        strokeThickness: 3,
      })
      .setOrigin(0.5, 1)
      .setVisible(false);

    const container = this.add.container(spawn.screen.x, spawn.screen.y, [
      mech,
      cpuTrack,
      cpuFill,
      memTrack,
      memFill,
      label,
      badge,
    ]);
    container.setDepth(spawn.tileSum + 0.5);

    const state: NpcState = {
      container,
      mech,
      robotTex,
      heading: "S",
      cpuFill,
      memFill,
      badge,
      homeTile: spawn.tile,
      currentTile: spawn.tile,
      latest: p,
      busy: false,
      workingDir: null,
      tripId: 0,
    };
    this.applyUsage(state, p);
    return state;
  }

  private applyUsage(state: NpcState, p: ProcessSnapshot) {
    state.latest = p;
    state.cpuFill.displayWidth = BAR_W * clamp01(p.cpu);
    state.cpuFill.fillColor = cpuBarColor(p.cpu);
    state.memFill.displayWidth = BAR_W * clamp01(p.mem / MEM_BAR_FULL);
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
    state.badge.setText(act.direction === "read" ? "▼ read" : "▲ write");
    state.badge.setColor(act.direction === "read" ? READ_COLOR : WRITE_COLOR);
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
      scaleY: 0.9,
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
      state.mech.setScale(1);
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

  private showProcTooltip(p: ProcessSnapshot) {
    if (this.dragging || !this.tooltip) return;
    const cpu = `${(p.cpu * 100).toFixed(0)}%`;
    const mem = `${(p.mem * 100).toFixed(1)}%`;
    this.tooltip.textContent = `pid:  ${p.pid}\ncomm: ${p.comm}\ncpu:  ${cpu} of one core\nmem:  ${mem} of RAM\nexe:  ${p.exe}`;
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
