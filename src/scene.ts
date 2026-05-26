import Phaser from "phaser";
import type { BuildingDescriptor, Region } from "../shared/types.ts";
import type { LiveMessage, ProcessSnapshot } from "../shared/proc-types.ts";
import {
  BUILDING_NAMES,
  BUILDING_VARIANTS,
  TOOL_SPRITE_KEYS,
  type BuildingSpriteKey,
} from "../shared/sprites.ts";
import { liveSocketUrl } from "./api.ts";
import { Sidebar, SIDEBAR_FRACTION } from "./sidebar.ts";
import { TerminalsUI } from "./terminals.ts";
import {
  drawIslandSides,
  drawIslandEdges,
  drawIslandLinks,
  paintIslandTop,
  FLOOR_COUNT,
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
  npcWorldPosition,
  robotForBuilding,
  robotTextureKey,
  rowForHeading,
  type RobotKey,
} from "./npc.ts";

const GROUND_DEPTH = -20;
const LINK_DEPTH = -19.5;
const FLOOR_DEPTH = -19;
const EDGE_DEPTH = -18;
const LABEL_DEPTH = 100000;
const STATION_KEYS = Array.from(
  { length: FLOOR_COUNT },
  (_, i) => `floor/station/${i + 1}`,
);
const WORK_LABEL_COLOR = "#7fe0d0";
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
  building: BuildingDescriptor;
  currentTile: { x: number; y: number };
  homeTile: { x: number; y: number };
  latest: ProcessSnapshot;
  busy: boolean;
  workingDir: string | null;
  tripId: number;
};

type CitySceneData = { buildings: BuildingDescriptor[]; regions: Region[] };

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

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

function brightenTint(tint: number, amount: number): number {
  const mix = (channel: number) =>
    Math.round(channel + (255 - channel) * amount);
  const r = mix((tint >> 16) & 0xff);
  const g = mix((tint >> 8) & 0xff);
  const b = mix(tint & 0xff);
  return (r << 16) | (g << 8) | b;
}

function hexColor(value: number): string {
  return `#${value.toString(16).padStart(6, "0")}`;
}

function labelColor(tint: number): string {
  return hexColor(brightenTint(tint, 0.55));
}

function buildingAssetUrl(key: BuildingSpriteKey): string {
  const parts = key.split("/");
  if (parts[0] === "tool") {
    return `/isotop-assets/sci-fi/buildings/tools/${parts[1]}.png`;
  }
  const name = parts[1]!;
  const variant = parts[2]!;
  const dir = encodeURIComponent(`Step ${variant}`);
  return `/isotop-assets/sci-fi/buildings/${dir}/${name}.png`;
}

function robotAssetUrl(key: RobotKey): string {
  if ((NAMED_ROBOTS as readonly string[]).includes(key)) {
    return `/isotop-assets/sci-fi/units/Robots/Spritesheets/${key}-8dir-walk-hover.png`;
  }
  return `/isotop-assets/sci-fi/units/Mech/Spritesheets/${key}-8dir-walk-hover.png`;
}

function terrainAssetUrl(index: number): string {
  const n = index.toString().padStart(2, "0");
  return `/isotop-assets/sci-fi/terrain/station/floor-${n}.png`;
}

export class CityScene extends Phaser.Scene {
  private buildings: BuildingDescriptor[] = [];
  private regions: Region[] = [];
  private regionByPath = new Map<string, Region>();
  private buildingByExe = new Map<string, BuildingDescriptor>();
  private npcs = new Map<number, NpcState>();
  private sidesGraphics: Phaser.GameObjects.Graphics | null = null;
  private linksGraphics: Phaser.GameObjects.Graphics | null = null;
  private edgesGraphics: Phaser.GameObjects.Graphics | null = null;
  private groundBlitters = new Map<string, Phaser.GameObjects.Blitter>();
  private regionLabels: Phaser.GameObjects.Text[] = [];
  private tooltip: HTMLDivElement | null = null;
  private dragging = false;
  private sidebar: Sidebar | null = null;
  private terminals: TerminalsUI | null = null;
  private termBuildings = new Map<
    string,
    { sprite: Phaser.GameObjects.Image; label: Phaser.GameObjects.Text }
  >();
  private termCount = 0;

  constructor() {
    super("city");
  }

  init(data: CitySceneData) {
    this.buildings = data.buildings ?? [];
    this.regions = data.regions ?? [];
    this.buildingByExe = new Map(this.buildings.map((b) => [b.id, b]));
  }

  preload() {
    for (const name of BUILDING_NAMES) {
      for (const v of BUILDING_VARIANTS) {
        const key: BuildingSpriteKey = `building/${name}/${v}`;
        this.load.image(key, buildingAssetUrl(key));
      }
    }
    for (const key of TOOL_SPRITE_KEYS) {
      this.load.image(key, buildingAssetUrl(key));
    }
    for (const key of ROBOT_KEYS) {
      this.load.spritesheet(robotTextureKey(key), robotAssetUrl(key), {
        frameWidth: ROBOT_FRAME_W,
        frameHeight: ROBOT_FRAME_H,
      });
    }
    for (let i = 0; i < FLOOR_COUNT; i++) {
      this.load.image(STATION_KEYS[i]!, terrainAssetUrl(i + 1));
    }
    this.load.image("icon/terminal", "/isotop-assets/sci-fi/icons/terminal.png");
  }

  create() {
    const sorted = [...this.buildings].sort(
      (a, b) => a.tile.x + a.tile.y - (b.tile.x + b.tile.y),
    );

    this.applyCameraViewport();
    this.scale.on("resize", () => this.applyCameraViewport());

    this.createRobotAnims();
    this.sidesGraphics = this.add.graphics().setDepth(GROUND_DEPTH);
    this.linksGraphics = this.add.graphics().setDepth(LINK_DEPTH);
    this.edgesGraphics = this.add.graphics().setDepth(EDGE_DEPTH);
    this.renderRegions();

    for (const d of sorted) {
      this.placeBuildingSprite(d);
    }

    const maxTileSum = this.buildings.reduce(
      (m, d) =>
        Math.max(m, d.tile.x + d.footprint.w + d.tile.y + d.footprint.h),
      0,
    );
    this.cameras.main.centerOn(0, (maxTileSum * TILE_H) / 4);

    this.sidebar = new Sidebar({
      onBuildTerminal: () => void this.terminals?.spawn(),
    });
    this.terminals = new TerminalsUI({
      host: this.sidebar.terminalHost,
      onOpened: (id) => this.addTerminalBuilding(id),
      onClosed: (id) => this.removeTerminalBuilding(id),
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

  private groundBlitterFor(key: string): Phaser.GameObjects.Blitter {
    let b = this.groundBlitters.get(key);
    if (!b) {
      b = this.add.blitter(0, 0, key).setDepth(FLOOR_DEPTH);
      this.groundBlitters.set(key, b);
    }
    return b;
  }

  private renderRegions() {
    if (!this.sidesGraphics || !this.edgesGraphics || !this.linksGraphics) {
      return;
    }
    this.sidesGraphics.clear();
    this.linksGraphics.clear();
    this.edgesGraphics.clear();
    for (const b of this.groundBlitters.values()) b.clear();
    for (const label of this.regionLabels) label.destroy();
    this.regionLabels = [];
    this.regionByPath = new Map(this.regions.map((r) => [r.path, r]));

    drawIslandLinks(this.linksGraphics, this.regions);

    const ordered = [...this.regions].sort(
      (a, b) => a.origin.x + a.origin.y - (b.origin.x + b.origin.y),
    );
    for (const r of ordered) {
      drawIslandSides(this.sidesGraphics, r);
      paintIslandTop((key) => this.groundBlitterFor(key), r, STATION_KEYS);
      drawIslandEdges(this.edgesGraphics, r);

      const isWork = r.kind === "work";
      const corner = tileToScreen(r.origin.x, r.origin.y);
      const text = formatRegionLabel(r.path);
      const label = this.add
        .text(corner.x, corner.y - 4, text, {
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          fontSize: "13px",
          color: isWork ? WORK_LABEL_COLOR : labelColor(r.tint),
          fontStyle: isWork ? "italic" : "normal",
        })
        .setOrigin(0.5, 1)
        .setDepth(LABEL_DEPTH);
      this.regionLabels.push(label);
    }
  }

  private placeBuildingSprite(d: BuildingDescriptor) {
    const tilePos = tileToScreen(d.tile.x, d.tile.y);
    const img = this.add.image(
      tilePos.x,
      tilePos.y + TILE_H,
      d.spriteKey,
    );
    img.setOrigin(0.5, 1);
    img.setDepth(d.tile.x + d.tile.y);
    img.setInteractive({ pixelPerfect: true });
    img.on("pointerover", () => this.showBuildingTooltip(d));
    img.on("pointerout", () => this.hideTooltip());
  }

  private addBuilding(d: BuildingDescriptor) {
    if (this.buildingByExe.has(d.id)) return;
    this.buildings.push(d);
    this.buildingByExe.set(d.id, d);
    this.placeBuildingSprite(d);
    // Ground is redrawn once by the world-delta handler after all buildings
    // are added, not per building.
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
          for (const d of msg.buildings) {
            this.addBuilding(d);
          }
          this.regions = msg.regions;
          this.renderRegions();
          console.log(
            `[ws] +${msg.buildings.length} new building(s), ${msg.regions.length} regions`,
          );
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
      const building = this.buildingByExe.get(p.exe);
      if (!building) continue;
      const state = this.createNpc(p, building);
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
  }

  private createNpc(
    p: ProcessSnapshot,
    building: BuildingDescriptor,
  ): NpcState {
    const spawn = npcWorldPosition(p.pid, building);
    const robotTex = robotTextureKey(robotForBuilding(building.spriteKey, p.pid));
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
      building,
      currentTile: spawn.tile,
      homeTile: spawn.tile,
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
    if (!act || act.dir === state.building.district) return;
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
      x: state.building.tile.x + off.x,
      y: state.building.tile.y + off.y,
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

  private addTerminalBuilding(id: string) {
    const i = this.termCount++;
    const tx = 1 + (i % 5) * 2;
    const ty = 1 + Math.floor(i / 5) * 2;
    const pos = tileToScreen(tx, ty);
    const sprite = this.add
      .image(pos.x, pos.y + TILE_H, "icon/terminal")
      .setOrigin(0.5, 1)
      .setDepth(tx + ty + 0.2);
    sprite.setInteractive({ pixelPerfect: true });
    sprite.on("pointerover", () =>
      this.showSimpleTooltip(`terminal ${id} — click to open`),
    );
    sprite.on("pointerout", () => this.hideTooltip());
    sprite.on("pointerup", () => this.terminals?.open(id));
    const label = this.add
      .text(pos.x, pos.y + TILE_H - 58, `\u{1F5A5} ${id}`, {
        fontFamily: "ui-monospace, monospace",
        fontSize: "11px",
        color: "#7fe0d0",
        stroke: "#0a0a12",
        strokeThickness: 3,
      })
      .setOrigin(0.5, 1)
      .setDepth(LABEL_DEPTH);
    this.termBuildings.set(id, { sprite, label });
  }

  private removeTerminalBuilding(id: string) {
    const t = this.termBuildings.get(id);
    if (!t) return;
    t.sprite.destroy();
    t.label.destroy();
    this.termBuildings.delete(id);
  }

  private showSimpleTooltip(text: string) {
    if (this.dragging || !this.tooltip) return;
    this.tooltip.textContent = text;
    this.tooltip.style.display = "block";
  }

  private createTooltip(): HTMLDivElement {
    const el = document.createElement("div");
    el.style.cssText = [
      "position:fixed",
      "pointer-events:none",
      "display:none",
      "background:#1a1a28",
      "color:#e0e0f0",
      "border:1px solid #6bb6ff",
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

  private showBuildingTooltip(d: BuildingDescriptor) {
    if (this.dragging || !this.tooltip) return;
    this.tooltip.textContent = `${d.id}\nhash:  ${d.hashShort}\nsize:  ${formatSize(d.size)}`;
    this.tooltip.style.display = "block";
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
