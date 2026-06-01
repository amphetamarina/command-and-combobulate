import { expect, test, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Region } from "./types.ts";
import type { AgentSnapshot, FileActivity, FileEntry, FolderFiles } from "./proc-types.ts";

// The C# mod hand-mirrors the TS wire types with no codegen. This contract test
// fails on drift: the TS samples are typed, so adding a field to a TS wire type
// forces the sample to grow, which then fails the comparison until the matching
// C# [JsonPropertyName] is added (and vice versa).
const LIVE_MESSAGE_CS = resolve(
  import.meta.dir,
  "../command-and-combobulate/OpenRA.Mods.Combobulate/Protocol/LiveMessage.cs",
);

// Parse the C# model into { className: [jsonPropertyName, ...] } by reading the
// [JsonPropertyName("...")] attributes. Computed properties (IsTerminal,
// IsSubagent) carry no attribute and are intentionally excluded.
function parseCsharpClasses(src: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  let current: string | null = null;
  let fields: string[] = [];
  let depth = 0;
  for (const line of src.split("\n")) {
    if (!current) {
      const m = line.match(/^\s*public class (\w+)/);
      if (m && m[1]) {
        current = m[1];
        fields = [];
        out[current] = fields;
        depth = 0;
      }
    }
    if (!current) continue;
    const prop = line.match(/JsonPropertyName\("([^"]+)"\)/);
    if (prop && prop[1]) fields.push(prop[1]);
    for (const ch of line) {
      if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        current = null;
        break;
      }
    }
  }
  return out;
}

const tileXY: Region["origin"] = { x: 0, y: 0 };
const tileWH: Region["size"] = { w: 0, h: 0 };
const fileArea: Region["fileArea"] = { x: 0, y: 0, cols: 0, rows: 0 };

const region: Region = {
  path: "/repo",
  kind: "work",
  label: "repo",
  role: "other",
  origin: tileXY,
  size: tileWH,
  tint: 0,
  level: 0,
  fileArea,
};

const fileActivity: FileActivity = {
  path: "/repo/x.ts",
  dir: "/repo",
  direction: "read",
  verb: "read",
  outcome: "ok",
};

const agentSnapshot: AgentSnapshot = {
  id: "t1",
  terminal: "t1",
  kind: "agent",
  parent: null,
  tool: "claude",
  label: "claude",
  activity: null,
  recent: [],
  contextFraction: null,
  lastMessage: null,
};

const fileEntry: FileEntry = {
  path: "/repo/x.ts",
  name: "x.ts",
  size: 0,
  direction: "read",
  role: "other",
  ts: 0,
};

const folderFiles: FolderFiles = { dir: "/repo", entries: [] };

// The LiveMessage envelope has no single TS type; it is built inline as three
// frames in server/live.ts and server/files.ts. The C# LiveMessage is their
// flattened union. Mirror the three frames here so drift in the envelope shape
// also trips this test.
const liveMessageKeys = [
  ...Object.keys({ kind: "agents", capturedAt: 0, agents: [] as AgentSnapshot[] }),
  ...Object.keys({ kind: "world-delta", regions: [] as Region[] }),
  ...Object.keys({ kind: "files", files: [] as FolderFiles[] }),
];

const expected: Record<string, string[]> = {
  TileXY: Object.keys(tileXY),
  TileWH: Object.keys(tileWH),
  FileArea: Object.keys(fileArea),
  Region: Object.keys(region),
  FileActivity: Object.keys(fileActivity),
  AgentSnapshot: Object.keys(agentSnapshot),
  FileEntry: Object.keys(fileEntry),
  FolderFiles: Object.keys(folderFiles),
  LiveMessage: [...new Set(liveMessageKeys)],
};

const csharp = parseCsharpClasses(readFileSync(LIVE_MESSAGE_CS, "utf8"));

describe("wire protocol contract (TS <-> C# LiveMessage.cs)", () => {
  test("the C# model declares exactly the TS wire classes", () => {
    expect(Object.keys(csharp).sort()).toEqual(Object.keys(expected).sort());
  });

  for (const [cls, tsKeys] of Object.entries(expected)) {
    test(`${cls} fields match between TS and C#`, () => {
      const got = csharp[cls];
      expect(got).toBeDefined();
      expect([...(got ?? [])].sort()).toEqual([...tsKeys].sort());
    });
  }
});
