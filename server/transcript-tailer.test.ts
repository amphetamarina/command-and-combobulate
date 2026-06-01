import { test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, appendFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TranscriptTailer } from "./transcript.ts";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "combobulate-tail-"));
  path = join(dir, "session.jsonl");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const use = (id: string, name: string, input: unknown) =>
  JSON.stringify({
    type: "assistant",
    cwd: "/p",
    message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
  }) + "\n";

const result = (id: string, isError: boolean) =>
  JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: isError }] },
  }) + "\n";

test("a tailer starts at the current end and ignores prior history", () => {
  writeFileSync(path, use("old", "Bash", { command: "echo hi" }) + result("old", false));
  const tailer = new TranscriptTailer(path);
  expect(tailer.readNew()).toEqual([]);

  appendFileSync(path, use("new", "Bash", { command: "make" }) + result("new", false));
  const out = tailer.readNew();
  expect(out.map((a) => a.toolUseId)).toEqual(["new", "new"]);
  expect(out[1]).toMatchObject({ verb: "build", outcome: "ok" });
});

test("a tailer missing its file yet starts at offset 0 and reads all", () => {
  const tailer = new TranscriptTailer(path);
  writeFileSync(path, use("a", "Read", { file_path: "/p/x.ts" }) + result("a", false));
  const out = tailer.readNew();
  expect(out).toHaveLength(2);
  expect(out[1]).toMatchObject({ verb: "read", outcome: "ok" });
});

test("a partial trailing line is buffered until its newline arrives", () => {
  const tailer = new TranscriptTailer(path);
  writeFileSync(path, "");
  const full = use("p", "Bash", { command: "ls /nope" }) + result("p", true);
  const half = full.slice(0, 40);
  const rest = full.slice(40);

  appendFileSync(path, half);
  expect(tailer.readNew()).toEqual([]); // no complete line yet

  appendFileSync(path, rest);
  const out = tailer.readNew();
  expect(out.map((a) => a.outcome)).toEqual(["pending", "error"]);
});

test("a tailer resets to the start when the file shrinks (truncation)", () => {
  // A long initial file, fully consumed.
  writeFileSync(
    path,
    use("one", "Bash", { command: "make ".repeat(40) }) + result("one", false),
  );
  const tailer = new TranscriptTailer(path);
  tailer.readNew();

  // Replaced by a shorter file: size < offset triggers a reset to 0.
  writeFileSync(path, use("two", "Read", { file_path: "/p/y.ts" }) + result("two", false));
  const out = tailer.readNew();
  expect(out.map((a) => a.toolUseId)).toEqual(["two", "two"]);
});
