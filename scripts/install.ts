// `bun run setup` — wire the Command & Clanker adapters into the agent CLIs so
// you do not have to pass plugin paths by hand. Every adapter only does anything
// inside a Command & Clanker terminal (where CLANKER_SESSION is injected), so this
// is safe to run once globally. Idempotent.
//
//   claude   — a hook in ~/.claude/settings.json.
//   opencode — a plugin symlinked into ~/.config/opencode/plugin.
//   codex    — a Claude-compatible plugin added from a local marketplace.
//   hermes   — a shell hook in ~/.hermes/config.yaml that translates events.

import { mkdir, readFile, writeFile, symlink, rm, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repo = resolve(import.meta.dirname, "..");
const claudeHook = resolve(repo, "integrations/claude/clanker/clanker-hook.sh");
const opencodePlugin = resolve(repo, "integrations/opencode/clanker/clanker.js");
const codexMarketplace = resolve(repo, "integrations/codex");
const codexHook = resolve(repo, "integrations/codex/plugins/clanker/clanker-hook.sh");
const hermesHook = resolve(repo, "integrations/hermes/clanker/clanker-hermes-hook.mjs");
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

async function installHermes(): Promise<string> {
  const path = join(home, ".hermes", "config.yaml");
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return "skipped (no ~/.hermes/config.yaml)";
  }
  await chmod(hermesHook, 0o755);

  // Rewrite any previously-installed clanker hook line to point at the current
  // absolute path. A repo move or rename (e.g. the old "isotop" location) would
  // otherwise leave hermes invoking a missing file silently, since hermes only
  // logs hook errors at high verbosity.
  const staleHook = /^(\s*-\s*command:\s*node\s+)(\S*clanker-hermes-hook\.mjs)\s*$/gm;
  if (staleHook.test(text)) {
    const fixed = text.replace(staleHook, (_, prefix) => `${prefix}${hermesHook}`);
    if (fixed !== text) {
      await writeFile(`${path}.clanker.bak`, text);
      await writeFile(path, fixed);
      return `${path} (rewrote stale clanker hook path -> ${hermesHook})`;
    }
    return `${path} (already wired)`;
  }

  const block =
    "hooks:\n" +
    "  on_session_start:\n" +
    `    - command: node ${hermesHook}\n` +
    "  on_session_end:\n" +
    `    - command: node ${hermesHook}\n` +
    "  post_tool_call:\n" +
    `    - command: node ${hermesHook}`;

  // The fresh config has an empty `hooks: {}` we can replace cleanly; otherwise
  // leave the user's existing hooks alone and print the snippet instead.
  if (/^hooks:[ \t]*\{\}[ \t]*$/m.test(text)) {
    await writeFile(`${path}.clanker.bak`, text);
    await writeFile(path, text.replace(/^hooks:[ \t]*\{\}[ \t]*$/m, block));
    return `${path} (approve at first run, or set HERMES_ACCEPT_HOOKS=1)`;
  }
  return `${path} (has hooks already — add the clanker hook manually; see integrations/hermes)`;
}

const claude = await installClaude();
const opencode = await installOpencode();
const codex = await installCodex();
const hermes = await installHermes();

console.log("Command & Clanker adapters installed:");
console.log(`  Claude hooks    -> ${claude}`);
console.log(`  Grok            -> reuses the Claude hook (reads ~/.claude automatically)`);
console.log(`  opencode plugin -> ${opencode}`);
console.log(`  Codex plugin    -> ${codex}`);
console.log(`  Hermes hook     -> ${hermes}`);
console.log(
  "They only report inside Command & Clanker terminals (CLANKER_SESSION is",
);
console.log("injected there), so they stay quiet everywhere else. Run an agent and watch the map.");
