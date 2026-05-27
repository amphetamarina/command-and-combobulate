// `bun run setup` — wire the Command & Clanker adapters into Claude Code and
// opencode so you do not have to pass plugin paths by hand. Both adapters only
// do anything inside a Command & Clanker terminal (where CLANKER_SESSION is
// injected), so this is safe to run once globally. Idempotent, and it also
// removes any wiring left by the pre-rebrand "aiso" adapters.

import { mkdir, readFile, writeFile, symlink, rm, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const repo = resolve(import.meta.dirname, "..");
const claudeHook = resolve(repo, "integrations/claude/clanker/clanker-hook.sh");
const opencodePlugin = resolve(repo, "integrations/opencode/clanker/clanker.js");
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

async function installClaude(): Promise<string> {
  const path = join(home, ".claude", "settings.json");
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch {
    /* fresh */
  }
  const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>;
  const entry = { hooks: [{ type: "command", command: claudeHook }] };
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

async function installOpencode(): Promise<string> {
  const dir = join(home, ".config", "opencode", "plugin");
  const link = join(dir, "clanker.js");
  await mkdir(dir, { recursive: true });
  // Drop the current link and any pre-rebrand "aiso.js" link before recreating.
  for (const stale of [link, join(dir, "aiso.js")]) {
    try {
      await rm(stale);
    } catch {
      /* nothing to remove */
    }
  }
  await symlink(opencodePlugin, link);
  return link;
}

const claude = await installClaude();
const opencode = await installOpencode();
console.log("Command & Clanker adapters installed:");
console.log(`  Claude hooks    -> ${claude}`);
console.log(`  opencode plugin -> ${opencode}`);
console.log(
  "They only report inside Command & Clanker terminals (CLANKER_SESSION is",
);
console.log("injected there), so they stay quiet everywhere else. Run an agent and watch the map.");
