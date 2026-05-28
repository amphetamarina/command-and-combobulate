import { test, expect } from "bun:test";
import { classifyFile, classifyDir, classifyVerb, classifyOk } from "./classify.ts";

test("classifyFile picks role by name and path", () => {
  expect(classifyFile("/p/src/foo.ts")).toBe("source");
  expect(classifyFile("/p/main.py")).toBe("source");
  expect(classifyFile("/p/foo.test.ts")).toBe("test");
  expect(classifyFile("/p/foo.spec.js")).toBe("test");
  expect(classifyFile("/p/tests/helper.ts")).toBe("test");
  expect(classifyFile("/p/__tests__/x.ts")).toBe("test");
  expect(classifyFile("/p/package.json")).toBe("manifest");
  expect(classifyFile("/p/Cargo.toml")).toBe("manifest");
  expect(classifyFile("/p/bun.lock")).toBe("manifest");
  expect(classifyFile("/p/tsconfig.json")).toBe("config");
  expect(classifyFile("/p/config.yaml")).toBe("config");
  expect(classifyFile("/p/.env")).toBe("config");
  expect(classifyFile("/p/README.md")).toBe("docs");
  expect(classifyFile("/p/notes.txt")).toBe("docs");
  expect(classifyFile("/p/dist/bundle.js")).toBe("build");
  expect(classifyFile("/p/target/release/x")).toBe("build");
  expect(classifyFile("/p/LICENSE")).toBe("other");
});

test("classifyFile prefers test over manifest over build over config", () => {
  expect(classifyFile("/p/tests/data.json")).toBe("test");
  expect(classifyFile("/p/dist/package.json")).toBe("manifest");
});

test("classifyDir picks role by basename", () => {
  expect(classifyDir("/p/src")).toBe("source");
  expect(classifyDir("/p/lib")).toBe("source");
  expect(classifyDir("/p/tests")).toBe("tests");
  expect(classifyDir("/p/spec")).toBe("tests");
  expect(classifyDir("/p/.git")).toBe("vcs");
  expect(classifyDir("/p/node_modules")).toBe("deps");
  expect(classifyDir("/p/vendor")).toBe("deps");
  expect(classifyDir("/p/.venv")).toBe("deps");
  expect(classifyDir("/p/.github")).toBe("ci");
  expect(classifyDir("/p/docs")).toBe("docs");
  expect(classifyDir("/p/whatever")).toBe("other");
});

test("classifyVerb maps tools and refines Bash by command", () => {
  expect(classifyVerb("Read", "")).toBe("read");
  expect(classifyVerb("Grep", "")).toBe("search");
  expect(classifyVerb("Glob", "")).toBe("search");
  expect(classifyVerb("Edit", "")).toBe("edit");
  expect(classifyVerb("Write", "")).toBe("edit");
  expect(classifyVerb("MultiEdit", "")).toBe("edit");
  expect(classifyVerb("WebFetch", "")).toBe("fetch");
  expect(classifyVerb("WebSearch", "")).toBe("fetch");
  expect(classifyVerb("Task", "")).toBe("spawn");
  expect(classifyVerb("Bash", "npm install")).toBe("build");
  expect(classifyVerb("Bash", "bun run build")).toBe("build");
  expect(classifyVerb("Bash", "cargo build --release")).toBe("build");
  expect(classifyVerb("Bash", "make")).toBe("build");
  expect(classifyVerb("Bash", "rm -rf dist")).toBe("destroy");
  expect(classifyVerb("Bash", "kill -9 123")).toBe("destroy");
  expect(classifyVerb("Bash", "ls -la")).toBe("run");
  expect(classifyVerb("Bash", "")).toBe("run");
  expect(classifyVerb("Unknown", "")).toBe("run");
});

test("classifyOk reads explicit success/failure fields", () => {
  expect(classifyOk({ exit_code: 0 })).toBe(true);
  expect(classifyOk({ exit_code: 1 })).toBe(false);
  expect(classifyOk({ exitCode: 2 })).toBe(false);
  expect(classifyOk({ code: 0 })).toBe(true);
  expect(classifyOk({ interrupted: true })).toBe(false);
  expect(classifyOk({ success: false })).toBe(false);
  expect(classifyOk({ is_error: true })).toBe(false);
  expect(classifyOk({ error: "boom" })).toBe(false);
});

test("classifyOk infers Bash failure from stderr without stdout", () => {
  // Claude Code's Bash tool_response has no exit code, so a command that
  // wrote only to stderr reads as a failure (e.g. `ls /nope`).
  expect(classifyOk({ stdout: "", stderr: "ls: cannot access", interrupted: false })).toBe(false);
  expect(classifyOk({ stdout: "files", stderr: "", interrupted: false })).toBe(true);
  // A build that warns on stderr but produces stdout is still a success.
  expect(classifyOk({ stdout: "compiled", stderr: "warning: x", interrupted: false })).toBe(true);
});

test("classifyOk treats a completed response with no failure markers as success", () => {
  expect(classifyOk({ type: "create", filePath: "/a.cs" })).toBe(true);
  expect(classifyOk({ file: { content: "..." } })).toBe(true);
});

test("classifyOk is null when the outcome is unknown", () => {
  expect(classifyOk(undefined)).toBe(null);
  expect(classifyOk("plain string")).toBe(null);
});
