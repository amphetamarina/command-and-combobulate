import Phaser from "phaser";
import type { BuildingDescriptor } from "../shared/types.ts";
import type { LiveMessage, ProcessSnapshot } from "../shared/proc-types.ts";
import {
  BUILDING_NAMES,
  BUILDING_VARIANTS,
  type BuildingSpriteKey,
} from "../shared/sprites.ts";
import { liveSocketUrl } from "./api.ts";
import { drawGround } from "./ground.ts";
import { TILE_H, tileToScreen } from "./iso.ts";
import {
  NPC_VARIANT_KEYS,
  WANDER_OFFSETS,
  npcSpriteKey,
  npcWorldPosition,
  type NpcSpriteKey,
} from "./npc.ts";

const GROUND_PADDING = 4;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.15;
const WS_RECONNECT_MS = 2000;
const WANDER_MIN_MS = 1500;
const WANDER_MAX_MS = 3500;
const WANDER_STAGGER_MS = 2000;

type NpcState = {
  sprite: Phaser.GameObjects.Image;
  building: BuildingDescriptor;
  currentTile: { x: number; y: number };
};

type CitySceneData = { buildings: BuildingDescriptor[] };

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function buildingAssetUrl(key: BuildingSpriteKey): string {
  const parts = key.split("/");
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

export class CityScene extends Phaser.Scene {
  private buildings: BuildingDescriptor[] = [];
  private buildingByExe = new Map<string, BuildingDescriptor>();
  private npcs = new Map<number, NpcState>();
  private groundGraphics: Phaser.GameObjects.Graphics | null = null;
  private tooltip: HTMLDivElement | null = null;
  private dragging = false;

  constructor() {
    super("city");
  }

  init(data: CitySceneData) {
    this.buildings = data.buildings ?? [];
    this.buildingByExe = new Map(this.buildings.map((b) => [b.id, b]));
  }

  preload() {
    for (const name of BUILDING_NAMES) {
      for (const v of BUILDING_VARIANTS) {
        const key: BuildingSpriteKey = `building/${name}/${v}`;
        this.load.image(key, buildingAssetUrl(key));
      }
    }
    for (const key of NPC_VARIANT_KEYS) {
      this.load.image(key, npcAssetUrl(key));
    }
  }

  create() {
    const sorted = [...this.buildings].sort(
      (a, b) => a.tile.x + a.tile.y - (b.tile.x + b.tile.y),
    );

    const extentX = this.buildings.reduce(
      (m, d) => Math.max(m, d.tile.x + d.footprint.w),
      1,
    );
    const extentY = this.buildings.reduce(
      (m, d) => Math.max(m, d.tile.y + d.footprint.h),
      1,
    );

    this.groundGraphics = this.add.graphics();
    this.redrawGround();

    for (const d of sorted) {
      this.placeBuildingSprite(d);
    }

    const maxTileSum = this.buildings.reduce(
      (m, d) =>
        Math.max(m, d.tile.x + d.footprint.w + d.tile.y + d.footprint.h),
      0,
    );
    this.cameras.main.centerOn(0, (maxTileSum * TILE_H) / 4);

    this.tooltip = this.createTooltip();
    this.setupPan();
    this.setupZoom();
    this.setupTooltipFollow();
    this.startLiveSocket();
  }

  private redrawGround() {
    if (!this.groundGraphics) return;
    const extentX = this.buildings.reduce(
      (m, d) => Math.max(m, d.tile.x + d.footprint.w),
      1,
    );
    const extentY = this.buildings.reduce(
      (m, d) => Math.max(m, d.tile.y + d.footprint.h),
      1,
    );
    this.groundGraphics.clear();
    drawGround(
      this.groundGraphics,
      Math.ceil(extentX),
      Math.ceil(extentY),
      GROUND_PADDING,
    );
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
    this.redrawGround();
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
          console.log(`[ws] +${msg.buildings.length} new building(s)`);
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
      if (this.npcs.has(p.pid)) continue;
      const building = this.buildingByExe.get(p.exe);
      if (!building) continue;
      const spawn = npcWorldPosition(p.pid, building);
      const sprite = this.add.image(
        spawn.screen.x,
        spawn.screen.y,
        npcSpriteKey(p.pid),
      );
      sprite.setOrigin(0.5, 1);
      sprite.setDepth(spawn.tileSum + 0.5);
      sprite.setInteractive({ pixelPerfect: true });
      sprite.on("pointerover", () => this.showProcTooltip(p));
      sprite.on("pointerout", () => this.hideTooltip());
      const state: NpcState = {
        sprite,
        building,
        currentTile: spawn.tile,
      };
      this.npcs.set(p.pid, state);
      this.scheduleWander(state);
    }
    for (const [pid, state] of this.npcs) {
      if (!seen.has(pid)) {
        state.sprite.destroy();
        this.npcs.delete(pid);
      }
    }
  }

  private scheduleWander(state: NpcState) {
    this.time.delayedCall(Math.random() * WANDER_STAGGER_MS, () =>
      this.wanderOnce(state),
    );
  }

  private wanderOnce(state: NpcState) {
    if (!state.sprite.active) return;
    const off =
      WANDER_OFFSETS[Math.floor(Math.random() * WANDER_OFFSETS.length)]!;
    const targetTile = {
      x: state.building.tile.x + off.x,
      y: state.building.tile.y + off.y,
    };
    const targetScreen = tileToScreen(targetTile.x, targetTile.y);
    const startTile = { x: state.currentTile.x, y: state.currentTile.y };
    this.tweens.add({
      targets: state.sprite,
      x: targetScreen.x,
      y: targetScreen.y + TILE_H / 2,
      duration: WANDER_MIN_MS + Math.random() * (WANDER_MAX_MS - WANDER_MIN_MS),
      ease: "Sine.easeInOut",
      onUpdate: (tween) => {
        const p = tween.progress;
        const cx = startTile.x + (targetTile.x - startTile.x) * p;
        const cy = startTile.y + (targetTile.y - startTile.y) * p;
        state.sprite.setDepth(cx + cy + 0.5);
      },
      onComplete: () => {
        state.currentTile = targetTile;
        state.sprite.setDepth(targetTile.x + targetTile.y + 0.5);
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
    this.tooltip.textContent = `pid:  ${p.pid}\ncomm: ${p.comm}\nexe:  ${p.exe}`;
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
