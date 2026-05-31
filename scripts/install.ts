// `bun run setup` — wire the Command & Clanker adapters into the agent CLIs so
// you do not have to pass plugin paths by hand. Every adapter only does anything
// inside a Command & Clanker terminal (where CLANKER_SESSION is injected), so this
// is safe to run once globally. Idempotent.
//
//   claude   — a hook in ~/.claude/settings.json.
//   codex    — a Claude-compatible plugin added from a local marketplace.

import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repo = resolve(import.meta.dirname, "..");
const claudeHook = resolve(repo, "integrations/claude/clanker/clanker-hook.sh");
const codexMarketplace = resolve(repo, "integrations/codex");
const codexHook = resolve(repo, "integrations/codex/plugins/clanker/clanker-hook.sh");
const home = homedir();

const CLAUDE_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "PostToolUse",
  "SubagentStart",
  "SubagentStop",
];

// Hook commands left by this or a previous install. Re-running setup strips
// these before re-adding, so entries never stack. "aiso-hook.sh" is the
// pre-rebrand name and is cleaned up here too.
const STALE_HOOK_NAMES = ["clanker-hook.sh", "aiso-hook.sh"];

function has(cmd: string): boolean {
  return spawnSync("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" }).status === 0;
}

async function installClaude(): Promise<string> {
  const path = join(home, ".claude", "settings.json");
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch {
    /* fresh */
  }
  const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>;
  const entry = { hooks: [{ type: "command", command: `${claudeHook} claude` }] };
  for (const ev of CLAUDE_EVENTS) {
    const list = Array.isArray(hooks[ev]) ? hooks[ev] : [];
    const cleaned = list.filter(
      (e) => !STALE_HOOK_NAMES.some((name) => JSON.stringify(e).includes(name)),
    );
    cleaned.push(entry);
    hooks[ev] = cleaned;
  }
  settings.hooks = hooks;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`);
  await chmod(claudeHook, 0o755);
  return path;
}

async function installCodex(): Promise<string> {
  if (!has("codex")) return "skipped (codex not installed)";
  await chmod(codexHook, 0o755);
  // Codex installs plugins from a marketplace snapshot; add ours and install it.
  // Best-effort and idempotent — tolerate a missing/locked codex.
  spawnSync("codex", ["plugin", "marketplace", "add", codexMarketplace], {
    stdio: "ignore",
    timeout: 30000,
  });
  spawnSync("codex", ["plugin", "add", "clanker@clanker"], {
    stdio: "ignore",
    timeout: 30000,
  });
  return "added clanker@clanker (trust its hooks in Codex on first use)";
}

const claude = await installClaude();
const codex = await installCodex();

console.log("Command & Clanker adapters installed:");
console.log(`  Claude hooks    -> ${claude}`);
console.log(`  Codex plugin    -> ${codex}`);
console.log(
  "They only report inside Command & Clanker terminals (CLANKER_SESSION is",
);
console.log("injected there), so they stay quiet everywhere else. Run an agent and watch the map.");
