import * as p from "@clack/prompts";
import pc from "picocolors";
import { detect, has } from "../core/detect.js";
import { DEFAULT_CONFIG, loadConfig, saveConfig, type Config } from "../core/config.js";
import { TOOLS, toolById, isPresent } from "../core/tools.js";
import { installTools, applyGitConfig } from "../core/install.js";
import { apply, version } from "../core/render.js";
import { installBlock } from "../core/shellrc.js";
import { THEMES, type ThemeName } from "../themes/index.js";
import { CONFIG_DIR, tilde } from "../core/paths.js";
import { banner } from "../core/ui.js";

/** Clack returns a symbol when the user hits Ctrl-C; treat that as "leave everything alone". */
function bail(value: unknown): void {
  if (p.isCancel(value)) {
    p.cancel("Nothing was changed.");
    process.exit(0);
  }
}

export async function init(opts: { yes?: boolean } = {}): Promise<void> {
  console.log();
  p.intro(banner(version()));

  const env = detect();
  const existing = loadConfig();

  p.note(
    [
      `${pc.dim("os".padEnd(10))} ${env.os}`,
      `${pc.dim("shell".padEnd(10))} ${env.shell || "unknown"}${env.isZsh ? "" : pc.yellow("  (not zsh)")}`,
      `${pc.dim("packages".padEnd(10))} ${env.packageManager === "none" ? pc.yellow("none found") : env.packageManager}`,
      `${pc.dim("font".padEnd(10))} ${env.nerdFont ? pc.green("Nerd Font found") : pc.yellow("no Nerd Font")}`,
      `${pc.dim("terminal".padEnd(10))} ${env.terminal}`,
    ].join("\n"),
    "Detected",
  );

  if (!env.isZsh) {
    // Being honest up front beats writing config into a shell that never reads it.
    const go = await p.confirm({
      message: `Your login shell isn't zsh. shellup only configures zsh — install anyway?`,
      initialValue: false,
    });
    bail(go);
    if (!go) {
      p.outro("Run `chsh -s $(which zsh)` first, then try again.");
      return;
    }
  }

  if (existing) {
    p.log.info(`Existing setup found (theme ${pc.cyan(existing.theme)}). This will reconfigure it.`);
    // Your previous answers stay pre-selected, so anything shellup has added since
    // then would sit unchecked and unnoticed. Call it out rather than opting you in.
    const added = TOOLS.filter((t) => t.recommended && !existing.tools.includes(t.id));
    if (added.length) {
      p.log.info(
        `New since your last run: ${added.map((t) => pc.cyan(t.label)).join(", ")}` +
          `\n  Press ${pc.cyan("Space")} on the list below to add ${added.length > 1 ? "them" : "it"}.`,
      );
    }
  }

  // ── Theme ────────────────────────────────────────────────────────────────
  const theme = (await p.select({
    message: "Pick a prompt theme",
    initialValue: existing?.theme ?? (env.nerdFont ? "powerline" : "minimal"),
    options: THEMES.map((t) => ({
      value: t.name,
      label: t.label + (t.requiresNerdFont && !env.nerdFont ? pc.yellow("  — needs a Nerd Font") : ""),
      hint: t.hint,
    })),
  })) as ThemeName;
  bail(theme);

  const chosen = THEMES.find((t) => t.name === theme)!;
  p.note(chosen.preview.join("\n"), `Preview — ${chosen.label}`);

  if (chosen.requiresNerdFont && !env.nerdFont) {
    p.log.warn(
      `${chosen.label} draws with Nerd Font glyphs. Without one you'll see boxes.\n` +
        (env.packageManager === "brew"
          ? `  Install one:  ${pc.cyan("brew install --cask font-jetbrains-mono-nerd-font")}`
          : `  Get one at:   ${pc.cyan("https://nerdfonts.com")}`) +
        `\n  Then set it as your terminal font.`,
    );
  }

  // ── Tools ────────────────────────────────────────────────────────────────
  const selectedTools = (await p.multiselect({
    message: "Which tools should shellup set up?",
    required: false,
    initialValues: existing?.tools ?? TOOLS.filter((t) => t.recommended).map((t) => t.id),
    options: TOOLS.map((t) => ({
      value: t.id,
      label: t.label + (isPresent(t) ? pc.green("  (installed)") : ""),
      hint: t.hint,
    })),
  })) as string[];
  bail(selectedTools);

  // ── Extras ───────────────────────────────────────────────────────────────
  const extras = (await p.multiselect({
    message: "Shell defaults to enable",
    required: false,
    initialValues: [
      ...(existing?.aliases ?? true ? ["aliases"] : []),
      ...(existing?.functions ?? true ? ["functions"] : []),
      ...(existing?.keybindings ?? true ? ["keybindings"] : []),
    ],
    options: [
      { value: "aliases", label: "Aliases", hint: "git shortcuts, ..  ...  , safety rails on cp/mv" },
      { value: "functions", label: "Functions", hint: "mkcd, extract, serve, onport, bak, cdr" },
      { value: "keybindings", label: "Keybindings", hint: "prefix history search on ↑, word jumps, Ctrl-Z toggle" },
    ],
  })) as string[];
  bail(extras);

  const config: Config = {
    ...DEFAULT_CONFIG,
    ...(existing ?? {}),
    theme,
    tools: selectedTools,
    aliases: extras.includes("aliases"),
    functions: extras.includes("functions"),
    keybindings: extras.includes("keybindings"),
    nerdFont: env.nerdFont,
    installedAt: existing?.installedAt ?? new Date().toISOString(),
  };

  // ── Install missing binaries ─────────────────────────────────────────────
  const missing = selectedTools.map((id) => toolById(id)!).filter((t) => t && !isPresent(t));
  if (missing.length && env.packageManager !== "none") {
    const doInstall =
      opts.yes ||
      (await p.confirm({
        message: `Install ${missing.length} missing tool${missing.length > 1 ? "s" : ""} with ${env.packageManager}? (${missing.map((t) => t.label).join(", ")})`,
        initialValue: true,
      }));
    bail(doInstall);

    if (doInstall) {
      const s = p.spinner();
      s.start(`Installing with ${env.packageManager}…`);
      const res = installTools(missing, env.packageManager);
      s.stop(
        res.installed.length
          ? `Installed ${res.installed.join(", ")}`
          : "Nothing new installed",
      );
      if (res.failed.length) {
        p.log.warn(`Could not install: ${res.failed.join(", ")}\n  Try manually: ${pc.dim(res.command ?? "")}`);
      }
    }
  } else if (missing.length) {
    p.log.warn(
      `No supported package manager found, so these stay uninstalled: ${missing.map((t) => t.label).join(", ")}\n` +
        `  Their config is still written and activates automatically once they're on PATH.`,
    );
  }

  // ── git-delta needs global git config, which is outside our directory ─────
  const delta = toolById("delta")!;
  if (selectedTools.includes("delta") && isPresent(delta) && delta.gitConfig) {
    const doGit = await p.confirm({
      message: "Set git to use delta for diffs? (writes to your global ~/.gitconfig)",
      initialValue: true,
    });
    bail(doGit);
    if (doGit) {
      applyGitConfig(delta.gitConfig)
        ? p.log.success("git configured to use delta")
        : p.log.warn("Could not write git config — is git installed?");
    }
  }

  // ── Write ────────────────────────────────────────────────────────────────
  const s = p.spinner();
  s.start("Writing config");
  apply(config);
  saveConfig(config);
  const { backup, replaced } = installBlock(env.rcFile);
  s.stop("Config written");

  p.note(
    [
      `${pc.dim("config".padEnd(10))} ${tilde(CONFIG_DIR)}`,
      `${pc.dim("zshrc".padEnd(10))} ${replaced ? "managed block updated" : "3-line managed block added"}`,
      backup ? `${pc.dim("backup".padEnd(10))} ${tilde(backup)}` : `${pc.dim("backup".padEnd(10))} ${pc.dim("no existing .zshrc")}`,
      `${pc.dim("yours".padEnd(10))} ${tilde(CONFIG_DIR + "/custom.zsh")} ${pc.dim("(never overwritten)")}`,
    ].join("\n"),
    "Done",
  );

  p.outro(`Restart your shell to see it:  ${pc.cyan("exec zsh")}`);
}
