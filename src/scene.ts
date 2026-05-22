import Phaser from "phaser";
import type { BuildingDescriptor } from "../shared/types.ts";
import { drawBuilding } from "./building-sprite.ts";
import { TILE_H, UNIT_HEIGHT } from "./iso.ts";

type CitySceneData = { buildings: BuildingDescriptor[] };

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.1;

export class CityScene extends Phaser.Scene {
  private buildings: BuildingDescriptor[] = [];

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

    const g = this.add.graphics();
    for (const d of sorted) drawBuilding(g, d);

    const maxTileSum = this.buildings.reduce(
      (m, d) =>
        Math.max(m, d.tile.x + d.footprint.w + d.tile.y + d.footprint.h),
      0,
    );
    const cityCenterY = (maxTileSum * TILE_H) / 4 - UNIT_HEIGHT;
    this.cameras.main.centerOn(0, cityCenterY);

    this.setupPan();
    this.setupZoom();
  }

  private setupPan() {
    const drag = { x: 0, y: 0, active: false };
    this.input.on("pointerdown", (p: Phaser.Input.Pointer) => {
      drag.active = true;
      drag.x = p.x;
      drag.y = p.y;
    });
    this.input.on("pointermove", (p: Phaser.Input.Pointer) => {
      if (!drag.active) return;
      const cam = this.cameras.main;
      cam.scrollX -= (p.x - drag.x) / cam.zoom;
      cam.scrollY -= (p.y - drag.y) / cam.zoom;
      drag.x = p.x;
      drag.y = p.y;
    });
    const stop = () => {
      drag.active = false;
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
