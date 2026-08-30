import * as p from "@clack/prompts";
import pc from "picocolors";
import { rmSync, existsSync } from "node:fs";
import { removeBlock } from "../core/shellrc.js";
import { detect } from "../core/detect.js";
import { CONFIG_DIR, BACKUP_DIR, tilde } from "../core/paths.js";
import { version } from "../core/render.js";
import { banner } from "../core/ui.js";

export async function uninstall(): Promise<void> {
  console.log();
  p.intro(banner(version()));
  const env = detect();

  const go = await p.confirm({
    message: `Remove shellup's block from ~/.zshrc?`,
    initialValue: true,
  });
  if (p.isCancel(go) || !go) {
    p.cancel("Nothing was changed.");
    return;
  }

  const { backup, removed } = removeBlock(env.rcFile);
  p.log.success(removed ? "Removed the managed block from ~/.zshrc" : "No managed block found in ~/.zshrc");
  if (backup) p.log.info(`Your .zshrc as it was a moment ago: ${tilde(backup)}`);

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
    p.log.info(`Backups of your .zshrc are in ${tilde(BACKUP_DIR)}`);
  }

  p.outro(`Done. Reload with ${pc.cyan("exec zsh")}.`);
}
