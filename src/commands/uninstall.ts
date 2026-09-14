import * as p from "@clack/prompts";
import pc from "picocolors";
import { rmSync, existsSync } from "node:fs";
import { removeBlock } from "../core/shellrc.js";
import { rcFilePath } from "../core/detect.js";
import { loadConfig, type Config } from "../core/config.js";
import { LEGACY_DELTA_GIT_CONFIG, toolById } from "../core/tools.js";
import { gitConfigGet, gitConfigSet } from "../core/install.js";
import { CONFIG_DIR, BACKUP_DIR, tilde } from "../core/paths.js";
import { version } from "../core/render.js";
import { banner } from "../core/ui.js";

export async function uninstall(): Promise<void> {
  console.log();
  p.intro(banner(version()));
  const rcFile = rcFilePath();

  let config: Config | null = null;
  try {
    config = loadConfig();
  } catch {
    // A broken config.json must never stop you uninstalling.
  }

  const go = await p.confirm({ message: `Remove shellup's block from ${tilde(rcFile)}?`, initialValue: true });
  if (p.isCancel(go) || !go) {
    p.cancel("Nothing was changed.");
    return;
  }

  let result: ReturnType<typeof removeBlock>;
  try {
    result = removeBlock(rcFile);
  } catch (err) {
    p.cancel(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }
  p.log.success(result.removed ? `Removed the managed block from ${tilde(rcFile)}` : `No managed block found in ${tilde(rcFile)}`);
  if (result.backup) p.log.info(`Your ${tilde(rcFile)} as it was a moment ago: ${tilde(result.backup)}`);

  if (!(await undoGitConfig(config))) return;

  const purge = await p.confirm({
    message: `Also delete ${tilde(CONFIG_DIR)}? (this includes your custom.zsh and rc backups)`,
    initialValue: false,
  });
  if (p.isCancel(purge)) {
    p.outro("Left the config directory in place.");
    return;
  }

  if (purge) {
    if (existsSync(CONFIG_DIR)) rmSync(CONFIG_DIR, { recursive: true, force: true });
    p.log.success(`Deleted ${tilde(CONFIG_DIR)}`);
  } else {
    p.log.info(`Kept ${tilde(CONFIG_DIR)} — reinstate any time with ${pc.cyan("shellup apply")}`);
    p.log.info(`Backups of your rc file are in ${tilde(BACKUP_DIR)}`);
  }

  p.outro(`Done. Reload with ${pc.cyan("exec zsh")}.`);
}

/**
 * Offers to undo the delta settings init wrote to ~/.gitconfig. Only settings still
 * holding exactly what shellup wrote are touched; anything you changed since is
 * yours and stays. Returns false if you cancelled.
 */
async function undoGitConfig(config: Config | null): Promise<boolean> {
  const known = new Map<string, string>([...LEGACY_DELTA_GIT_CONFIG, ...(toolById("delta")?.gitConfig ?? [])]);
  const ours = [...known].filter(([key, value]) => gitConfigGet(key) === value);
  if (!ours.length) return true;

  const backup = config?.gitConfigBackup ?? {};
  p.note(
    ours
      .map(([key, value]) => {
        const before = backup[key];
        return `${key} = ${value}   ${pc.dim(before ? `→ back to ${before}` : "→ remove")}`;
      })
      .join("\n"),
    "git settings shellup wrote for delta",
  );
  const undo = await p.confirm({
    message: "Undo these git settings too?",
    // With a record of what they were, restoring is safe. Without one (set up by
    // shellup 0.3.x or earlier) they may predate shellup, so don't assume.
    initialValue: ours.every(([key]) => key in backup),
  });
  if (p.isCancel(undo)) {
    p.cancel("Stopped. The shellup block is already removed; your git settings weren't changed.");
    return false;
  }
  if (!undo) {
    p.log.info("Left your git settings as they are.");
    return true;
  }
  const failed = ours.filter(([key]) => !gitConfigSet(key, backup[key] ?? null));
  if (failed.length) p.log.warn(`Couldn't change: ${failed.map(([key]) => key).join(", ")}`);
  else p.log.success("git settings undone");
  return true;
}
