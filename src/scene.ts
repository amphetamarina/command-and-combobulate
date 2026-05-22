import Phaser from "phaser";
import type { BuildingDescriptor } from "../shared/types.ts";
import {
  BUILDING_NAMES,
  BUILDING_VARIANTS,
  type BuildingSpriteKey,
} from "../shared/sprites.ts";
import { drawGround } from "./ground.ts";
import { TILE_H, tileToScreen } from "./iso.ts";

const GROUND_PADDING = 2;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.15;

type CitySceneData = { buildings: BuildingDescriptor[] };

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function spriteAssetUrl(key: BuildingSpriteKey): string {
  const parts = key.split("/");
  const name = parts[1]!;
  const variant = parts[2]!;
  const dir = encodeURIComponent(`Step ${variant}`);
  return `/sci-fi-acdrnx/sci-fi/buildings/${dir}/${name}.png`;
}

export class CityScene extends Phaser.Scene {
  private buildings: BuildingDescriptor[] = [];
  private tooltip: HTMLDivElement | null = null;
  private dragging = false;

  constructor() {
    super("city");
  }

  init(data: CitySceneData) {
    this.buildings = data.buildings ?? [];
  }

  preload() {
    for (const name of BUILDING_NAMES) {
      for (const v of BUILDING_VARIANTS) {
        const key: BuildingSpriteKey = `building/${name}/${v}`;
        this.load.image(key, spriteAssetUrl(key));
      }
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

    const ground = this.add.graphics();
    drawGround(ground, extentX, extentY, GROUND_PADDING);

    for (const d of sorted) {
      const tilePos = tileToScreen(d.tile.x, d.tile.y);
      const img = this.add.image(
        tilePos.x,
        tilePos.y + TILE_H,
        d.spriteKey,
      );
      img.setOrigin(0.5, 1);
      img.setDepth(d.tile.x + d.tile.y);
      img.setInteractive({ pixelPerfect: true });
      img.on("pointerover", () => this.showTooltip(d));
      img.on("pointerout", () => this.hideTooltip());
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

  private showTooltip(d: BuildingDescriptor) {
    if (this.dragging || !this.tooltip) return;
    this.tooltip.textContent = `${d.id}\nhash:  ${d.hashShort}\nsize:  ${formatSize(d.size)}`;
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
