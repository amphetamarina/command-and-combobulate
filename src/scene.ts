import Phaser from "phaser";
import type { BuildingDescriptor } from "../shared/types.ts";
import { drawBuilding } from "./building-sprite.ts";
import { drawGround } from "./ground.ts";
import { TILE_H, UNIT_HEIGHT } from "./iso.ts";
import { buildingOutline, pointInPolygon } from "./hit-test.ts";

const GROUND_PADDING = 2;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.1;

type CitySceneData = { buildings: BuildingDescriptor[] };

type HitEntry = {
  descriptor: BuildingDescriptor;
  outline: ReturnType<typeof buildingOutline>;
};

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export class CityScene extends Phaser.Scene {
  private buildings: BuildingDescriptor[] = [];
  private hitEntries: HitEntry[] = [];
  private tooltip: HTMLDivElement | null = null;
  private dragging = false;

  constructor() {
    super("city");
  }

  init(data: CitySceneData) {
    this.buildings = data.buildings ?? [];
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

    const g = this.add.graphics();
    for (const d of sorted) drawBuilding(g, d);

    this.hitEntries = [...sorted]
      .reverse()
      .map((d) => ({ descriptor: d, outline: buildingOutline(d) }));

    const maxTileSum = this.buildings.reduce(
      (m, d) =>
        Math.max(m, d.tile.x + d.footprint.w + d.tile.y + d.footprint.h),
      0,
    );
    const cityCenterY = (maxTileSum * TILE_H) / 4 - UNIT_HEIGHT;
    this.cameras.main.centerOn(0, cityCenterY);

    this.tooltip = this.createTooltip();
    this.setupPan();
    this.setupZoom();
    this.setupHover();
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

  private setupHover() {
    this.input.on("pointermove", (p: Phaser.Input.Pointer) => {
      if (this.dragging || !this.tooltip) return;
      const world = this.cameras.main.getWorldPoint(p.x, p.y);
      const hit = this.hitEntries.find((e) =>
        pointInPolygon(world, e.outline),
      );
      if (hit) {
        const d = hit.descriptor;
        this.tooltip.textContent = `${d.id}\nhash:  ${d.hashShort}\nsize:  ${formatSize(d.size)}`;
        this.tooltip.style.display = "block";
        const rect = this.game.canvas.getBoundingClientRect();
        this.tooltip.style.left = `${rect.left + p.x + 14}px`;
        this.tooltip.style.top = `${rect.top + p.y + 14}px`;
      } else {
        this.tooltip.style.display = "none";
      }
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
      if (this.tooltip) this.tooltip.style.display = "none";
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
