import pc from "picocolors";
import { existsSync } from "node:fs";
import { detect } from "../core/detect.js";
import { ConfigError, loadConfig, type Config } from "../core/config.js";
import { TOOLS, toolById, isPresent } from "../core/tools.js";
import { inspectBlock } from "../core/shellrc.js";
import { CONFIG_DIR, INIT_FILE, tilde } from "../core/paths.js";
import { version } from "../core/render.js";
import { themeByName } from "../themes/index.js";
import { banner, SYM } from "../core/ui.js";

const line = (state: "ok" | "warn" | "bad", label: string, detail: string) => {
  const mark = state === "ok" ? pc.green(SYM.ok) : state === "warn" ? pc.yellow(SYM.warn) : pc.red(SYM.bad);
  return `  ${mark}  ${label.padEnd(22)} ${pc.dim(detail)}`;
};

/**
 * Read-only. Explains what's wired up and what would fix anything that isn't, and
 * exits 1 when anything needs fixing, so it can be scripted.
 */
export function doctor(): void {
  const env = detect();
  const problems: string[] = [];

  let config: Config | null = null;
  let configError: string | null = null;
  try {
    config = loadConfig();
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    configError = err.message;
  }

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
  if (configError) {
    console.log(line("bad", "config", "unreadable — see below"));
    problems.push(configError);
  } else if (!config) {
    console.log(line("bad", "config", "not set up — run `shellup init`"));
    problems.push("run `shellup init` to set up");
  } else {
    console.log(line("ok", "config", tilde(CONFIG_DIR)));
  }

  const initPresent = existsSync(INIT_FILE);
  console.log(line(initPresent ? "ok" : "bad", "init.zsh", initPresent ? tilde(INIT_FILE) : "missing"));
  if (!initPresent && config) problems.push("init.zsh is missing — run `shellup apply`");

  const where = tilde(env.rcFile);
  const block = inspectBlock(env.rcFile);
  if (block === "present") {
    console.log(line("ok", "zshrc hook", `${where}: managed block present`));
  } else if (block === "absent") {
    console.log(line("bad", "zshrc hook", `${where}: no managed block`));
    if (config) problems.push(`${where} doesn't load shellup — run \`shellup apply\``);
  } else {
    console.log(line("bad", "zshrc hook", `${where}: start marker on line ${block.malformedAt} has no end marker`));
    problems.push(`${where} line ${block.malformedAt}: put "# <<< shellup <<<" back after the block, or delete the start marker`);
  }

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
    const present = isPresent(tool);
    if (!selected.has(tool.id) && !present) continue;
    const state = present ? "ok" : "warn";
    const detail = present
      ? selected.has(tool.id) ? "installed, integration active" : "installed, not managed by shellup"
      : "selected but not installed — integration is dormant";
    console.log(line(state, tool.label, detail));
  }
  const missing = [...selected].map((id) => toolById(id)).filter((t) => t && !isPresent(t));
  if (missing.length) problems.push(`install missing tools: ${missing.map((t) => t!.label).join(", ")}`);

  console.log();
  if (problems.length) {
    console.log(pc.bold(pc.yellow("  To fix")));
    for (const problem of problems) console.log(`  ${pc.dim("→")} ${problem}`);
    process.exitCode = 1;
  } else {
    console.log(`  ${pc.green(SYM.ok)}  ${pc.bold("Everything looks healthy.")}`);
  }
  console.log();
}
