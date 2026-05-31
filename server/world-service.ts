import { readlink } from "node:fs/promises";
import {
  buildWorld,
  releaseRegion,
  type PlacementCache,
  type TerminalInfo,
} from "./world-builder.ts";
import { saveCache } from "./persistence.ts";
import type { TerminalManager } from "./terminals.ts";
import type { WorkDirTracker } from "./workdirs.ts";
import type { World } from "../shared/types.ts";

// Builds the spatial world from the live terminals and touched folders, owning
// the placement cache and persisting it after each build.
export class WorldService {
  constructor(
    private readonly terminals: TerminalManager,
    private readonly workDirs: WorkDirTracker,
    private readonly placements: PlacementCache,
    private readonly cachePath: string,
  ) {}

  private async terminalInfos(): Promise<TerminalInfo[]> {
    return Promise.all(
      this.terminals.refs().map(async ({ id, pid }) => {
        let label = id;
        try {
          label = await readlink(`/proc/${pid}/cwd`);
        } catch {
          /* keep id */
        }
        return { id, label };
      }),
    );
  }

  async build(): Promise<World> {
    const infos = await this.terminalInfos();
    const world = buildWorld(infos, this.workDirs.keys(), this.placements);
    void saveCache(this.cachePath, this.placements);
    return world;
  }

  // Recycle a root's placement slot when its terminal or folder disappears.
  release(key: string): void {
    releaseRegion(this.placements, key);
  }
}
