import type { AgentRegistry } from "./agents.ts";
import type { FileRegistry } from "./files.ts";
import type { WorldService } from "./world-service.ts";

// The slice of a WebSocket the broadcaster needs. ws.WebSocket satisfies it
// structurally; tests pass a fake.
export type LiveClient = {
  readonly readyState: number;
  readonly OPEN: number;
  send(data: string): void;
};

// Owns the set of connected /live clients and turns domain state into the wire
// messages they receive. The message envelopes live here; the data projections
// come from the registries and the world service.
export class Broadcaster {
  private clients = new Set<LiveClient>();

  constructor(
    private readonly agents: AgentRegistry,
    private readonly files: FileRegistry,
    private readonly worldService: WorldService,
  ) {}

  add(client: LiveClient): void {
    this.clients.add(client);
  }

  remove(client: LiveClient): void {
    this.clients.delete(client);
  }

  get size(): number {
    return this.clients.size;
  }

  private send(client: LiveClient, message: string): void {
    if (client.readyState === client.OPEN) client.send(message);
  }

  private broadcast(message: string): void {
    for (const client of this.clients) this.send(client, message);
  }

  private agentsMessage(): string {
    return JSON.stringify({
      kind: "agents",
      capturedAt: Date.now(),
      agents: this.agents.snapshots(),
    });
  }

  agentsChanged(): void {
    this.broadcast(this.agentsMessage());
  }

  filesChanged(): void {
    this.broadcast(this.files.message());
  }

  async worldChanged(): Promise<void> {
    const world = await this.worldService.build();
    this.broadcast(JSON.stringify({ kind: "world-delta", regions: world.regions }));
  }

  // Send a new client the current files and agents immediately, then the world
  // once it is built, so it is in sync without waiting for the next change.
  snapshotTo(client: LiveClient): void {
    this.send(client, this.files.message());
    this.send(client, this.agentsMessage());
    void this.worldService.build().then((w) => {
      this.send(
        client,
        JSON.stringify({ kind: "world-delta", regions: w.regions }),
      );
    });
  }
}
