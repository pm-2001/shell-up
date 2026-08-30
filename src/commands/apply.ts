import pc from "picocolors";
import { loadConfig } from "../core/config.js";
import { apply as render } from "../core/render.js";
import { installBlock } from "../core/shellrc.js";
import { detect } from "../core/detect.js";
import { CONFIG_DIR, tilde } from "../core/paths.js";

/** Regenerate everything from config.json — the command to run after hand-editing it. */
export function applyCommand(): void {
  const config = loadConfig();
  if (!config) {
    console.error(pc.red("Nothing to apply — run `shellup init` first."));
    process.exitCode = 1;
    return;
  }
  render(config);
  const { backup, replaced } = installBlock(detect().rcFile);
  console.log(
    `\n  ${pc.green("✔")} Regenerated ${pc.dim(tilde(CONFIG_DIR))}` +
      `\n  ${pc.green("✔")} ${replaced ? "Managed block refreshed" : "Managed block added"} in ${pc.dim("~/.zshrc")}` +
      (backup ? `\n  ${pc.dim("· backup: " + tilde(backup))}` : "") +
      `\n\n  Reload with ${pc.cyan("exec zsh")}.\n`,
  );
}
