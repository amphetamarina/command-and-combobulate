import Phaser from "phaser";
import type { BuildingDescriptor, Region } from "../shared/types.ts";
import type { LiveMessage, ProcessSnapshot } from "../shared/proc-types.ts";
import {
  BUILDING_NAMES,
  BUILDING_VARIANTS,
  TOOL_SPRITE_KEYS,
  type BuildingSpriteKey,
} from "../shared/sprites.ts";
import { killProcess, liveSocketUrl } from "./api.ts";
import { Sidebar, type MinimapStatic } from "./sidebar.ts";
import { TerminalsUI } from "./terminals.ts";
import { paintGround, FLOOR_COUNT } from "./ground.ts";
import { placeWalls, WALL_KEYS, wallAssetUrl } from "./walls.ts";
import { TILE_H, tileToScreen } from "./iso.ts";
import {
  NPC_VARIANT_KEYS,
  WANDER_OFFSETS,
  npcSpriteKey,
  npcWorldPosition,
  type NpcSpriteKey,
} from "./npc.ts";

const GROUND_PADDING = 4;
const DESERT_MARGIN = 10;
const REGION_DEPTH = -10;
const GROUND_DEPTH = -20;
const LABEL_DEPTH = 100000;
const REGION_TINT_ALPHA = 0.22;
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
  mech: Phaser.GameObjects.Image;
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

function npcAssetUrl(key: NpcSpriteKey): string {
  const variant = key.split("/")[2]!;
  const dir = encodeURIComponent(`step ${variant}`);
  return `/isotop-assets/sci-fi/units/Mech/${dir}/Idle/idlesued.png`;
}

const STATION_KEYS = Array.from(
  { length: FLOOR_COUNT },
  (_, i) => `floor/station/${i + 1}`,
);
const DESERT_KEYS = Array.from(
  { length: FLOOR_COUNT },
  (_, i) => `floor/desert/${i + 1}`,
);

function terrainAssetUrl(kind: "station" | "desert", index: number): string {
  const n = index.toString().padStart(2, "0");
  return `/isotop-assets/sci-fi/terrain/${kind}/floor-${n}.png`;
}

export class CityScene extends Phaser.Scene {
  private buildings: BuildingDescriptor[] = [];
  private regions: Region[] = [];
  private regionByPath = new Map<string, Region>();
  private buildingByExe = new Map<string, BuildingDescriptor>();
  private npcs = new Map<number, NpcState>();
  private groundBlitters = new Map<string, Phaser.GameObjects.Blitter>();
  private wallSprites: Phaser.GameObjects.Image[] = [];
  private regionGraphics: Phaser.GameObjects.Graphics | null = null;
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
  private selectedPid: number | null = null;
  private selectionMarker: Phaser.GameObjects.Ellipse | null = null;
  private minimapReady = false;

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
    for (const key of NPC_VARIANT_KEYS) {
      this.load.image(key, npcAssetUrl(key));
    }
    for (let i = 0; i < FLOOR_COUNT; i++) {
      this.load.image(STATION_KEYS[i]!, terrainAssetUrl("station", i + 1));
      this.load.image(DESERT_KEYS[i]!, terrainAssetUrl("desert", i + 1));
    }
    for (let i = 0; i < WALL_KEYS.length; i++) {
      this.load.image(WALL_KEYS[i]!, wallAssetUrl(i + 1));
    }
    this.load.image("icon/terminal", "/isotop-assets/sci-fi/icons/terminal.png");
  }

  create() {
    const sorted = [...this.buildings].sort(
      (a, b) => a.tile.x + a.tile.y - (b.tile.x + b.tile.y),
    );

    this.regionGraphics = this.add.graphics().setDepth(REGION_DEPTH);
    this.redrawGround();
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

    this.terminals = new TerminalsUI({
      onOpened: (id) => this.addTerminalBuilding(id),
      onClosed: (id) => this.removeTerminalBuilding(id),
      onList: (ids) =>
        this.sidebar?.setTerminals(ids, (id) => this.terminals?.open(id)),
    });
    this.sidebar = new Sidebar({
      onNavigate: (x, y) => this.cameras.main.centerOn(x, y),
      onKill: (pid) => void killProcess(pid),
      onBuildTerminal: () => void this.terminals?.spawn(),
    });
    void this.terminals.restore();
    this.rebuildMinimapStatic();

    this.tooltip = this.createTooltip();
    this.setupPan();
    this.setupZoom();
    this.setupTooltipFollow();
    this.startLiveSocket();
  }

  override update() {
    if (!this.sidebar || !this.minimapReady) return;
    const view = this.cameras.main.worldView;
    const npcs = [...this.npcs.entries()].map(([pid, s]) => ({
      x: s.container.x,
      y: s.container.y,
      selected: pid === this.selectedPid,
      working: s.busy,
    }));
    this.sidebar.drawMinimap(npcs, {
      x: view.x,
      y: view.y,
      w: view.width,
      h: view.height,
    });
  }

  private rebuildMinimapStatic() {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const note = (p: { x: number; y: number }) => {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    };

    const regions = this.regions.map((r) => {
      const corners = [
        tileToScreen(r.origin.x, r.origin.y),
        tileToScreen(r.origin.x + r.size.w, r.origin.y),
        tileToScreen(r.origin.x + r.size.w, r.origin.y + r.size.h),
        tileToScreen(r.origin.x, r.origin.y + r.size.h),
      ];
      const xs = corners.map((c) => c.x);
      const ys = corners.map((c) => c.y);
      const box = {
        x: Math.min(...xs),
        y: Math.min(...ys),
        w: Math.max(...xs) - Math.min(...xs),
        h: Math.max(...ys) - Math.min(...ys),
        tint: r.tint,
        work: r.kind === "work",
      };
      note({ x: box.x, y: box.y });
      note({ x: box.x + box.w, y: box.y + box.h });
      return box;
    });

    const buildings = this.buildings.map((b) => {
      const p = tileToScreen(b.tile.x, b.tile.y);
      note(p);
      return p;
    });

    if (!Number.isFinite(minX)) {
      minX = -100;
      minY = -100;
      maxX = 100;
      maxY = 100;
    }
    const staticData: MinimapStatic = {
      bounds: { minX, minY, maxX, maxY },
      regions,
      buildings,
    };
    this.sidebar?.setMinimapStatic(staticData);
    this.minimapReady = true;
  }

  private worldExtent(): { x: number; y: number } {
    let x = 1;
    let y = 1;
    for (const d of this.buildings) {
      x = Math.max(x, d.tile.x + d.footprint.w);
      y = Math.max(y, d.tile.y + d.footprint.h);
    }
    for (const r of this.regions) {
      x = Math.max(x, r.origin.x + r.size.w);
      y = Math.max(y, r.origin.y + r.size.h);
    }
    return { x: Math.ceil(x), y: Math.ceil(y) };
  }

  private groundBlitterFor(key: string): Phaser.GameObjects.Blitter {
    let b = this.groundBlitters.get(key);
    if (!b) {
      b = this.add.blitter(0, 0, key).setDepth(GROUND_DEPTH);
      this.groundBlitters.set(key, b);
    }
    return b;
  }

  private redrawGround() {
    for (const b of this.groundBlitters.values()) b.clear();
    for (const w of this.wallSprites) w.destroy();
    const extent = this.worldExtent();

    const buildingPads = new Set<string>();
    for (const b of this.buildings) {
      const cx = Math.round(b.tile.x);
      const cy = Math.round(b.tile.y);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          buildingPads.add(`${cx + dx},${cy + dy}`);
        }
      }
    }
    const regions = this.regions.map((r) => ({
      x0: r.origin.x,
      y0: r.origin.y,
      x1: r.origin.x + r.size.w,
      y1: r.origin.y + r.size.h,
    }));

    paintGround((key) => this.groundBlitterFor(key), {
      stationFloors: STATION_KEYS,
      desertFloors: DESERT_KEYS,
      buildingPads,
      regions,
      extentX: extent.x,
      extentY: extent.y,
      padding: GROUND_PADDING,
      desertMargin: DESERT_MARGIN,
    });
    this.wallSprites = placeWalls(this, extent.x, extent.y, GROUND_PADDING);
  }

  private renderRegions() {
    if (!this.regionGraphics) return;
    this.regionGraphics.clear();
    for (const label of this.regionLabels) label.destroy();
    this.regionLabels = [];
    this.regionByPath = new Map(this.regions.map((r) => [r.path, r]));

    for (const r of this.regions) {
      const isWork = r.kind === "work";
      const g = this.regionGraphics;
      g.fillStyle(r.tint, isWork ? REGION_TINT_ALPHA * 0.6 : REGION_TINT_ALPHA);
      for (let y = r.origin.y; y < r.origin.y + r.size.h; y++) {
        for (let x = r.origin.x; x < r.origin.x + r.size.w; x++) {
          const N = tileToScreen(x, y);
          const E = tileToScreen(x + 1, y);
          const S = tileToScreen(x + 1, y + 1);
          const W = tileToScreen(x, y + 1);
          g.beginPath();
          g.moveTo(N.x, N.y);
          g.lineTo(E.x, E.y);
          g.lineTo(S.x, S.y);
          g.lineTo(W.x, W.y);
          g.closePath();
          g.fillPath();
        }
      }

      if (isWork) {
        const ox = r.origin.x;
        const oy = r.origin.y;
        const top = tileToScreen(ox, oy);
        const right = tileToScreen(ox + r.size.w, oy);
        const bottom = tileToScreen(ox + r.size.w, oy + r.size.h);
        const leftPt = tileToScreen(ox, oy + r.size.h);
        g.lineStyle(2, brightenTint(r.tint, 0.5), 0.85);
        g.beginPath();
        g.moveTo(top.x, top.y);
        g.lineTo(right.x, right.y);
        g.lineTo(bottom.x, bottom.y);
        g.lineTo(leftPt.x, leftPt.y);
        g.closePath();
        g.strokePath();
      }

      const corner = tileToScreen(r.origin.x, r.origin.y);
      const text = isWork
        ? `◈ ${formatRegionLabel(r.path)}`
        : formatRegionLabel(r.path);
      const label = this.add
        .text(corner.x, corner.y - 6, text, {
          fontFamily: "ui-monospace, monospace",
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
          this.redrawGround();
          this.rebuildMinimapStatic();
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
        if (p.pid === this.selectedPid) this.refreshSelectionInfo();
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
        if (pid === this.selectedPid) {
          const p = state.latest;
          this.sidebar?.setSelection({
            pid: p.pid,
            comm: p.comm,
            exe: p.exe,
            cpu: 0,
            mem: 0,
            activity: null,
            alive: false,
          });
          this.selectedPid = null;
          this.selectionMarker = null;
        }
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
    const mech = this.add.image(0, 0, npcSpriteKey(p.pid)).setOrigin(0.5, 1);
    mech.setInteractive({ pixelPerfect: true });
    mech.on("pointerover", () => this.showProcTooltip(state.latest));
    mech.on("pointerout", () => this.hideTooltip());
    mech.on("pointerup", () => this.selectNpc(state.latest.pid));

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

  private selectNpc(pid: number) {
    const state = this.npcs.get(pid);
    if (!state) return;
    this.selectedPid = pid;
    this.selectionMarker?.destroy();
    const marker = this.add
      .ellipse(0, -2, 28, 14)
      .setStrokeStyle(2, 0x7fff7f, 0.9);
    state.container.addAt(marker, 0);
    this.selectionMarker = marker;
    this.refreshSelectionInfo();
  }

  private refreshSelectionInfo() {
    if (!this.sidebar || this.selectedPid === null) return;
    const state = this.npcs.get(this.selectedPid);
    if (!state) return;
    const p = state.latest;
    this.sidebar.setSelection({
      pid: p.pid,
      comm: p.comm,
      exe: p.exe,
      cpu: p.cpu,
      mem: p.mem,
      activity: p.activity
        ? { dir: p.activity.dir, direction: p.activity.direction }
        : null,
      alive: true,
    });
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
        onArrive();
      },
    });
  }

  private workInPlace(state: NpcState) {
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
    const startTile = { x: state.currentTile.x, y: state.currentTile.y };
    this.tweens.add({
      targets: state.container,
      x: targetScreen.x,
      y: targetScreen.y + TILE_H / 2,
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
