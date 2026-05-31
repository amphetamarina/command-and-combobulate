const WORK_DIR_TTL_MS = 600000;

// Tracks which directories an agent has recently touched, with a last-active
// timestamp per dir so idle ones can be swept. The set of tracked dirs is what
// the world builder turns into folder islands.
export class WorkDirTracker {
  private lastActive = new Map<string, number>();

  constructor(private readonly ttlMs = WORK_DIR_TTL_MS) {}

  // Mark a dir active. Returns true when it was newly tracked, so the caller
  // can flag the world dirty without the tracker reaching for a shared flag.
  touch(dir: string, now: number): boolean {
    const isNew = !this.lastActive.has(dir);
    this.lastActive.set(dir, now);
    return isNew;
  }

  keys(): string[] {
    return [...this.lastActive.keys()];
  }

  // Drop dirs idle past the ttl and return the evicted keys, so the caller can
  // release their placement and file state.
  evictIdle(now: number): string[] {
    const evicted: string[] = [];
    for (const [dir, last] of this.lastActive) {
      if (now - last > this.ttlMs) {
        this.lastActive.delete(dir);
        evicted.push(dir);
      }
    }
    return evicted;
  }
}
