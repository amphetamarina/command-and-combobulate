import seedrandom from "seedrandom";
import type { Region, World } from "../shared/types.ts";

// A folder reserves a top strip of FILE_ROWS for its own file icons, then lays
// its child sub-folders in a grid below, padded by PAD and spaced by GAP. The
// parent expands to contain its children, so subfolders nest inside instead of
// scattering across the map.
const PAD = 1;
const FILE_ROWS = 3;
const GAP = 1;
const LEAF_W = 4;
const TERMINAL_SIZE = 4;
const REGION_GUTTER = 2;

const TERMINAL_TINT = 0xff9ec7;
const WORK_TINTS = [
  0xc98aa6, 0xb88fb0, 0xc99a82, 0xa88fb8, 0xcf8f9a, 0x9a8fc0,
] as const;

export type TerminalInfo = { id: string; label: string };

export type PlacementCache = {
  region: Map<string, number>;
  building: Map<string, number>;
  freeRegionSlots: number[];
};

export function emptyCache(): PlacementCache {
  return { region: new Map(), building: new Map(), freeRegionSlots: [] };
}

export function releaseRegion(cache: PlacementCache, key: string): void {
  const slot = cache.region.get(key);
  if (slot === undefined) return;
  cache.region.delete(key);
  cache.freeRegionSlots.push(slot);
}

export function squareCell(slot: number): { col: number; row: number } {
  const ring = Math.floor(Math.sqrt(slot));
  const offset = slot - ring * ring;
  return offset <= ring
    ? { col: ring, row: offset }
    : { col: offset - ring - 1, row: ring };
}

type Node = {
  dir: string;
  children: Node[];
  innerW: number;
  size: { w: number; h: number };
};

function chunk<T>(items: T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += size) rows.push(items.slice(i, i + size));
  return rows;
}

// Build a forest of touched folders, parenting each dir under the deepest other
// touched dir that is a path-prefix of it.
function buildForest(workDirs: string[]): Node[] {
  const dirs = [...new Set(workDirs)].sort();
  const childrenOf = new Map<string, string[]>();
  const roots: string[] = [];
  for (const dir of dirs) {
    let parent: string | null = null;
    for (const other of dirs) {
      if (other === dir) continue;
      if (!dir.startsWith(`${other}/`)) continue;
      if (!parent || other.length > parent.length) parent = other;
    }
    if (parent) (childrenOf.get(parent) ?? childrenOf.set(parent, []).get(parent)!).push(dir);
    else roots.push(dir);
  }
  const makeNode = (dir: string): Node => ({
    dir,
    children: (childrenOf.get(dir) ?? []).sort().map(makeNode),
    innerW: 0,
    size: { w: 0, h: 0 },
  });
  return roots.map(makeNode);
}

function sizeNode(node: Node): void {
  node.children.forEach(sizeNode);
  if (node.children.length === 0) {
    node.innerW = LEAF_W;
    node.size = { w: LEAF_W + 2 * PAD, h: FILE_ROWS + 2 * PAD };
    return;
  }
  const cols = Math.ceil(Math.sqrt(node.children.length));
  const rows = chunk(node.children, cols);
  const rowWidth = (row: Node[]) =>
    row.reduce((sum, c) => sum + c.size.w, 0) + (row.length - 1) * GAP;
  const childrenW = Math.max(...rows.map(rowWidth));
  const childrenH =
    rows.reduce((sum, row) => sum + Math.max(...row.map((c) => c.size.h)), 0) +
    (rows.length - 1) * GAP;
  const innerW = Math.max(childrenW, LEAF_W);
  node.innerW = innerW;
  node.size = {
    w: innerW + 2 * PAD,
    h: FILE_ROWS + GAP + childrenH + 2 * PAD,
  };
}

function placeNode(
  node: Node,
  ox: number,
  oy: number,
  level: number,
): Region[] {
  const tintRng = seedrandom(node.dir);
  const out: Region[] = [
    {
      path: node.dir,
      kind: "work",
      label: node.dir,
      origin: { x: ox, y: oy },
      size: node.size,
      tint: WORK_TINTS[Math.floor(tintRng() * WORK_TINTS.length)]!,
      level,
      fileArea: { x: ox + PAD, y: oy + PAD, cols: node.innerW, rows: FILE_ROWS },
    },
  ];
  if (node.children.length === 0) return out;

  const cols = Math.ceil(Math.sqrt(node.children.length));
  let cy = oy + PAD + FILE_ROWS + GAP;
  for (const row of chunk(node.children, cols)) {
    let cx = ox + PAD;
    for (const child of row) {
      out.push(...placeNode(child, cx, cy, level + 1));
      cx += child.size.w + GAP;
    }
    cy += Math.max(...row.map((c) => c.size.h)) + GAP;
  }
  return out;
}

// The world is terminal islands plus a nested tree of folder islands; the files
// agents touch are rendered on top of the folder islands by the client.
export function buildWorld(
  terminals: TerminalInfo[],
  workDirs: string[] = [],
  cache: PlacementCache = emptyCache(),
): World {
  const termKeys = new Set(terminals.map((t) => t.id));
  const forest = buildForest(workDirs.filter((d) => !termKeys.has(d)));
  forest.forEach(sizeNode);

  // The roots placed on the meta-grid: terminals + top-level folders.
  const roots: { key: string; footprint: number }[] = [
    ...terminals.map((t) => ({ key: t.id, footprint: TERMINAL_SIZE })),
    ...forest.map((n) => ({ key: n.dir, footprint: Math.max(n.size.w, n.size.h) })),
  ];
  if (roots.length === 0) return { regions: [] };

  // Drop cached slots that are no longer roots (e.g. a folder gained an
  // ancestor and became a child), then assign slots to new roots.
  const rootKeys = new Set(roots.map((r) => r.key));
  for (const key of [...cache.region.keys()]) {
    if (!rootKeys.has(key)) releaseRegion(cache, key);
  }
  const free = cache.freeRegionSlots.sort((a, b) => a - b);
  let next = Math.max(-1, ...cache.region.values(), ...free) + 1;
  for (const r of roots) {
    if (!cache.region.has(r.key)) {
      cache.region.set(r.key, free.length > 0 ? free.shift()! : next++);
    }
  }
  cache.freeRegionSlots = free;

  const stride = Math.max(...roots.map((r) => r.footprint)) + REGION_GUTTER;
  const nodeByDir = new Map(forest.map((n) => [n.dir, n]));
  const regions: Region[] = [];
  for (const t of terminals) {
    const cell = squareCell(cache.region.get(t.id)!);
    const ox = cell.col * stride;
    const oy = cell.row * stride;
    regions.push({
      path: t.id,
      kind: "terminal",
      label: t.label,
      origin: { x: ox, y: oy },
      size: { w: TERMINAL_SIZE, h: TERMINAL_SIZE },
      tint: TERMINAL_TINT,
      level: 0,
      fileArea: { x: ox + 1, y: oy + 1, cols: TERMINAL_SIZE - 2, rows: TERMINAL_SIZE - 2 },
    });
  }
  for (const node of forest) {
    const cell = squareCell(cache.region.get(node.dir)!);
    regions.push(...placeNode(node, cell.col * stride, cell.row * stride, 0));
  }

  return { regions };
}
