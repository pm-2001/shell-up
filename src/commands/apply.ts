import pc from "picocolors";
import { loadConfig } from "../core/config.js";
import { apply as render } from "../core/render.js";
import { installBlock } from "../core/shellrc.js";
import { rcFilePath } from "../core/detect.js";
import { CONFIG_DIR, tilde } from "../core/paths.js";

/** Regenerate everything from config.json — the command to run after hand-editing it. */
export function applyCommand(): void {
  const config = loadConfig();
  if (!config) {
    console.error(pc.red("Nothing to apply — run `shellup init` first."));
    process.exitCode = 1;
    return;
  }
  const rcFile = rcFilePath();
  render(config);
  const { backup, replaced, changed } = installBlock(rcFile);
  const block = !changed ? "Managed block already up to date" : replaced ? "Managed block updated in place" : "Managed block added";
  console.log(
    `\n  ${pc.green("✔")} Regenerated ${pc.dim(tilde(CONFIG_DIR))}` +
      `\n  ${pc.green("✔")} ${block} in ${pc.dim(tilde(rcFile))}` +
      (backup ? `\n  ${pc.dim("· backup: " + tilde(backup))}` : "") +
      `\n\n  Reload with ${pc.cyan("exec zsh")}.\n`,
  );
}
