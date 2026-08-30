import * as p from "@clack/prompts";
import pc from "picocolors";
import { loadConfig, saveConfig } from "../core/config.js";
import { apply, version } from "../core/render.js";
import { THEMES, themeByName, type ThemeName } from "../themes/index.js";
import { detect } from "../core/detect.js";
import { banner } from "../core/ui.js";

export async function theme(name?: string): Promise<void> {
  const config = loadConfig();
  if (!config) {
    console.error(pc.red("shellup isn't set up yet. Run `shellup init` first."));
    process.exitCode = 1;
    return;
  }

  if (name) {
    const meta = themeByName(name);
    if (!meta) {
      console.error(
        pc.red(`Unknown theme "${name}".`) + ` Available: ${THEMES.map((t) => pc.cyan(t.name)).join(", ")}`,
      );
      process.exitCode = 1;
      return;
    }
    apply({ ...config, theme: meta.name });
    saveConfig({ ...config, theme: meta.name });
    console.log(`\n  Theme set to ${pc.cyan(meta.name)}. Reload with ${pc.cyan("exec zsh")}.\n`);
    return;
  }

  console.log();
  p.intro(banner(version()));
  const env = detect();

  const picked = (await p.select({
    message: "Pick a prompt theme",
    initialValue: config.theme,
    options: THEMES.map((t) => ({
      value: t.name,
      label: t.label + (t.requiresNerdFont && !env.nerdFont ? pc.yellow("  — needs a Nerd Font") : ""),
      hint: t.hint,
    })),
  })) as ThemeName;

  if (p.isCancel(picked)) {
    p.cancel("Theme unchanged.");
    return;
  }

  const meta = themeByName(picked)!;
  p.note(meta.preview.join("\n"), `Preview — ${meta.label}`);

  apply({ ...config, theme: picked });
  saveConfig({ ...config, theme: picked });
  p.outro(`Theme set to ${pc.cyan(picked)}. Reload with ${pc.cyan("exec zsh")}.`);
}
