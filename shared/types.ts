export type ManifestEntry = {
  path: string;
  hash: string;
  size: number;
};

// The role of a touched directory, so the map can style its compound by what
// the directory is for (source base, test barracks, dependency sprawl) rather
// than only by nesting depth.
export type DirRole =
  | "source"
  | "tests"
  | "vcs"
  | "deps"
  | "ci"
  | "docs"
  | "other";

export type Region = {
  // A folder path for work islands, or a terminal id ("t1") for terminal
  // islands.
  path: string;
  kind: "terminal" | "work";
  label: string;
  // For work regions, the directory's role; "other" for terminals and
  // unclassified folders.
  role: DirRole;
  origin: { x: number; y: number };
  size: { w: number; h: number };
  tint: number;
  // Nesting depth: 0 for terminals and top-level folders, +1 per subfolder.
  level: number;
  // The sub-rectangle (in tiles) where this folder's own file icons go, kept
  // clear of any child sub-islands.
  fileArea: { x: number; y: number; cols: number; rows: number };
};

export type World = {
  regions: Region[];
};
