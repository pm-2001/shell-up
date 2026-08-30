import pc from "picocolors";
import { detect, has } from "../core/detect.js";
import { loadConfig } from "../core/config.js";
import { TOOLS, toolById } from "../core/tools.js";
import { hasBlock } from "../core/shellrc.js";
import { CONFIG_DIR, INIT_FILE, tilde } from "../core/paths.js";
import { existsSync } from "node:fs";
import { version } from "../core/render.js";
import { themeByName } from "../themes/index.js";
import { banner, SYM } from "../core/ui.js";

const line = (state: "ok" | "warn" | "bad", label: string, detail: string) => {
  const mark = state === "ok" ? pc.green(SYM.ok) : state === "warn" ? pc.yellow(SYM.warn) : pc.red(SYM.bad);
  return `  ${mark}  ${label.padEnd(22)} ${pc.dim(detail)}`;
};

/** Read-only. Explains what's wired up and what would fix anything that isn't. */
export function doctor(): void {
  const env = detect();
  const config = loadConfig();
  const problems: string[] = [];

  console.log(`\n${banner(version())}\n`);

  console.log(pc.bold("  Environment"));
  console.log(line(env.isZsh ? "ok" : "bad", "shell", env.shell || "unknown"));
  if (!env.isZsh) problems.push("shellup configures zsh; switch with `chsh -s $(which zsh)`");
  console.log(line("ok", "os", env.os));
  console.log(line(env.packageManager === "none" ? "warn" : "ok", "package manager", env.packageManager));
  console.log(line("ok", "terminal", env.terminal));
  console.log(line(env.trueColor ? "ok" : "warn", "truecolor", env.trueColor ? "yes" : "not advertised (COLORTERM unset)"));
  console.log(line(env.nerdFont ? "ok" : "warn", "nerd font", env.nerdFont ? "found" : "none found"));

  console.log(`\n${pc.bold("  Installation")}`);
  console.log(line(config ? "ok" : "bad", "config", config ? tilde(CONFIG_DIR) : "not set up — run `shellup init`"));
  if (!config) problems.push("run `shellup init` to set up");
  console.log(line(existsSync(INIT_FILE) ? "ok" : "bad", "init.zsh", existsSync(INIT_FILE) ? tilde(INIT_FILE) : "missing — run `shellup apply`"));
  console.log(line(hasBlock(env.rcFile) ? "ok" : "bad", "zshrc hook", hasBlock(env.rcFile) ? "managed block present" : "missing — run `shellup apply`"));

  if (config) {
    const theme = themeByName(config.theme);
    const themeState = theme?.requiresNerdFont && !env.nerdFont ? "warn" : "ok";
    console.log(
      line(themeState, "theme", config.theme + (themeState === "warn" ? " — needs a Nerd Font, glyphs will show as boxes" : "")),
    );
    if (themeState === "warn") problems.push("install a Nerd Font, or run `shellup theme minimal`");
  }

  console.log(`\n${pc.bold("  Tools")}`);
  const selected = new Set(config?.tools ?? []);
  for (const tool of TOOLS) {
    const present = has(tool.bin);
    if (!selected.has(tool.id) && !present) continue;
    const state = present ? "ok" : "warn";
    const detail = present
      ? selected.has(tool.id) ? "installed, integration active" : "installed, not managed by shellup"
      : "selected but not installed — integration is dormant";
    console.log(line(state, tool.label, detail));
  }
  const missing = [...selected].map((id) => toolById(id)).filter((t) => t && !has(t.bin));
  if (missing.length) problems.push(`install missing tools: ${missing.map((t) => t!.label).join(", ")}`);

  console.log();
  if (problems.length) {
    console.log(pc.bold(pc.yellow("  To fix")));
    for (const problem of problems) console.log(`  ${pc.dim("→")} ${problem}`);
  } else {
    console.log(`  ${pc.green(SYM.ok)}  ${pc.bold("Everything looks healthy.")}`);
  }
  console.log();
}
