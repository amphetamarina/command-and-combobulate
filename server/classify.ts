import type { ActivityVerb, FileRole } from "../shared/proc-types.ts";
import type { DirRole } from "../shared/types.ts";

const MANIFEST_NAMES = new Set([
  "package.json",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "cargo.toml",
  "cargo.lock",
  "go.mod",
  "go.sum",
  "requirements.txt",
  "pipfile",
  "pipfile.lock",
  "pyproject.toml",
  "gemfile",
  "gemfile.lock",
  "composer.json",
  "composer.lock",
]);

const CONFIG_EXTS = new Set([
  "yaml",
  "yml",
  "json",
  "toml",
  "ini",
  "cfg",
  "conf",
  "env",
  "properties",
]);

const DOCS_EXTS = new Set(["md", "markdown", "rst", "txt", "adoc"]);

const SOURCE_EXTS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "py",
  "rs",
  "go",
  "c",
  "h",
  "cc",
  "cpp",
  "hpp",
  "cs",
  "java",
  "rb",
  "php",
  "swift",
  "kt",
  "kts",
  "scala",
  "sh",
  "bash",
  "zsh",
  "lua",
  "vue",
  "svelte",
  "sql",
]);

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

function extension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function hasSegment(path: string, segments: Set<string>): boolean {
  return path.split("/").some((s) => segments.has(s.toLowerCase()));
}

const TEST_DIRS = new Set(["tests", "test", "spec", "specs", "__tests__"]);
const BUILD_DIRS = new Set(["dist", "build", "target", "out"]);

export function classifyFile(path: string): FileRole {
  const name = basename(path).toLowerCase();
  if (/\.(test|spec)\.[^.]+$/.test(name) || hasSegment(path, TEST_DIRS)) return "test";
  if (MANIFEST_NAMES.has(name) || name.endsWith(".lock")) return "manifest";
  if (hasSegment(path, BUILD_DIRS)) return "build";
  const ext = extension(name);
  if (name.startsWith(".env") || CONFIG_EXTS.has(ext)) return "config";
  if (DOCS_EXTS.has(ext)) return "docs";
  if (SOURCE_EXTS.has(ext)) return "source";
  return "other";
}

const DIR_ROLES: { names: Set<string>; role: DirRole }[] = [
  { names: new Set(["src", "lib", "app", "source"]), role: "source" },
  { names: TEST_DIRS, role: "tests" },
  { names: new Set([".git"]), role: "vcs" },
  {
    names: new Set(["node_modules", "vendor", ".venv", "venv", "site-packages", ".cargo"]),
    role: "deps",
  },
  { names: new Set([".github", ".circleci", ".gitlab"]), role: "ci" },
  { names: new Set(["docs", "doc"]), role: "docs" },
];

export function classifyDir(dir: string): DirRole {
  const name = basename(dir).toLowerCase();
  for (const { names, role } of DIR_ROLES) if (names.has(name)) return role;
  return "other";
}

const BUILD_CMDS = /^(make|cmake|tsc|webpack|vite|rollup|esbuild|gradle|mvn|cargo|go|npm|pnpm|yarn|bun|pip|pip3|poetry|gcc|g\+\+|clang|rustc|dotnet)$/;
const DESTROY_CMDS = /^(rm|rmdir|kill|pkill|killall|dd|truncate|shred|unlink)$/;

export function classifyVerb(toolName: string, command: string): ActivityVerb {
  switch (toolName) {
    case "Read":
      return "read";
    case "Grep":
    case "Glob":
      return "search";
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "NotebookEdit":
      return "edit";
    case "WebFetch":
    case "WebSearch":
      return "fetch";
    case "Task":
      return "spawn";
    case "Bash":
      return classifyBash(command);
    default:
      return "run";
  }
}

function classifyBash(command: string): ActivityVerb {
  const parts = command.trim().split(/\s+/);
  const tool = basename(parts[0] ?? "").toLowerCase();
  if (DESTROY_CMDS.test(tool)) return "destroy";
  if (BUILD_CMDS.test(tool)) {
    // A build/install subcommand reads as build; `cargo test`, `npm run dev`,
    // or `go run` is plain execution. `<pm> run <script>` is build only when
    // the script name itself is build-ish.
    const sub = (parts[1] ?? "").toLowerCase();
    if (sub === "run") {
      const script = (parts[2] ?? "").toLowerCase();
      return /build|compile|bundle|dist|tsc|webpack|vite/.test(script) ? "build" : "run";
    }
    if (/^(test|fmt|clippy|check|lint|bench|start|dev|exec|version)$/.test(sub)) return "run";
    return "build";
  }
  return "run";
}

// Claude Code's PostToolUse payload carries a per-tool `tool_response` whose
// shape varies and does not guarantee a numeric exit code, so probe the fields
// known to signal failure and return null when none are present rather than
// guessing success.
export function classifyOk(toolResponse: unknown): boolean | null {
  if (!toolResponse || typeof toolResponse !== "object") return null;
  const r = toolResponse as Record<string, unknown>;
  for (const key of ["exit_code", "exitCode", "code"]) {
    if (typeof r[key] === "number") return r[key] === 0;
  }
  if (r.interrupted === true) return false;
  if (r.success === false) return false;
  if (r.is_error === true) return false;
  if (r.error) return false;
  return null;
}
