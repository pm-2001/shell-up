import * as p from "@clack/prompts";
import pc from "picocolors";
import { detect } from "../core/detect.js";
import { DEFAULT_CONFIG, loadConfig, saveConfig, type Config } from "../core/config.js";
import { TOOLS, toolById, isPresent, type Tool } from "../core/tools.js";
import { installTools, applyGitConfig, InstallInterrupted, type InstallResult } from "../core/install.js";
import { apply, version } from "../core/render.js";
import { installBlock } from "../core/shellrc.js";
import { THEMES, type ThemeName } from "../themes/index.js";
import { CONFIG_DIR, tilde } from "../core/paths.js";
import { banner } from "../core/ui.js";

/** What init has already changed outside its own files, so stopping it reports the truth. */
const done: string[] = [];

/** Clack returns a symbol when you press Ctrl-C at a prompt. */
function bail(value: unknown): void {
  if (!p.isCancel(value)) return;
  p.cancel(
    done.length
      ? `Stopped. Already done: ${done.join("; ")}. Your shell config was not changed.`
      : "Nothing was changed.",
  );
  process.exit(130);
}

/** Enough semver for shellup's own x.y.z versions. */
function newer(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

const labels = (ids: string[]) => ids.map((id) => toolById(id)?.label ?? id).join(", ");

export async function init(opts: { yes?: boolean; skipIntro?: boolean } = {}): Promise<void> {
  // Read the config before drawing anything. An unreadable config.json has to stop
  // init with its error, not pass for a first run and get overwritten with defaults.
  const existing = loadConfig();

  if (!opts.skipIntro) {
    console.log();
    p.intro(banner(version()));
  }

  const env = detect();

  p.note(
    [
      `${pc.dim("os".padEnd(10))} ${env.os}`,
      `${pc.dim("shell".padEnd(10))} ${env.shell || "unknown"}${env.isZsh ? "" : pc.yellow("  (not zsh)")}`,
      `${pc.dim("zshrc".padEnd(10))} ${tilde(env.rcFile)}`,
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
    // Your earlier answers stay pre-selected, so a tool shellup has added since would
    // sit unticked and unnoticed. Only tools that genuinely weren't on offer last time
    // are mentioned, never ones you turned down.
    const lastRun = existing.shellupVersion ?? "0.1.0";
    const added = TOOLS.filter(
      (t) => t.recommended && t.since !== undefined && newer(t.since, lastRun) && !existing.tools.includes(t.id),
    );
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

  // ── Install missing binaries ─────────────────────────────────────────────
  const missing = selectedTools
    .map((id) => toolById(id))
    .filter((t): t is Tool => t !== undefined && !isPresent(t));
  if (missing.length && env.packageManager !== "none") {
    const doInstall =
      opts.yes ||
      (await p.confirm({
        message: `Install ${missing.length} missing tool${missing.length > 1 ? "s" : ""} with ${env.packageManager}? (${missing.map((t) => t.label).join(", ")})`,
        initialValue: true,
      }));
    bail(doInstall);

    if (doInstall) {
      // No spinner: the package manager gets the terminal, so a sudo password prompt
      // works and Ctrl-C reaches it instead of being swallowed.
      p.log.step(`Installing with ${env.packageManager}. Its own output follows.`);
      let res: InstallResult;
      try {
        res = installTools(missing, env.packageManager);
      } catch (err) {
        if (!(err instanceof InstallInterrupted)) throw err;
        p.cancel("Install interrupted. Your shell config was not changed.");
        process.exit(130);
      }
      if (res.installed.length) {
        done.push(`installed ${labels(res.installed)}`);
        p.log.success(`Installed ${labels(res.installed)}`);
      }
      if (res.noSudo) p.log.warn(`${env.packageManager} needs root, and sudo isn't available here.`);
      if (res.failed.length) {
        p.log.warn(
          `Could not install: ${labels(res.failed)}` +
            (res.retry.length ? `\n  Try by hand:\n${res.retry.map((c) => `    ${pc.dim(c)}`).join("\n")}` : "") +
            `\n  Their config is still written and turns on once they're on your PATH.`,
        );
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
  let gitConfigBackup = existing?.gitConfigBackup;
  if (selectedTools.includes("delta") && isPresent(delta) && delta.gitConfig) {
    const doGit = await p.confirm({
      message: "Set git to use delta for diffs? (writes to your global ~/.gitconfig; uninstall can undo it)",
      initialValue: true,
    });
    bail(doGit);
    if (doGit) {
      const previous = applyGitConfig(delta.gitConfig);
      if (!previous) {
        p.log.warn("Could not write git config — is git installed?");
      } else {
        const record: Record<string, string | null> = { ...(gitConfigBackup ?? {}) };
        for (const [key, value] of delta.gitConfig) {
          // Keep the first value ever recorded, or a second run would save shellup's own
          // setting as "what it was before". Keys that already held this exact value (set
          // by you, or by an older shellup) aren't recorded, so uninstall asks about them.
          if (key in record || previous[key] === value) continue;
          record[key] = previous[key] ?? null;
        }
        gitConfigBackup = record;
        done.push("set git to use delta");
        p.log.success("git configured to use delta");
      }
    }
  }

  // ── Write ────────────────────────────────────────────────────────────────
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
    shellupVersion: version(),
    ...(gitConfigBackup ? { gitConfigBackup } : {}),
  };

  // No spinner here either: writing takes milliseconds, and a spinner left running by
  // an exception kept the process alive forever. The rc file goes before config.json,
  // so a read-only or malformed .zshrc doesn't leave a config claiming setup finished.
  let rc: ReturnType<typeof installBlock>;
  try {
    apply(config);
    rc = installBlock(env.rcFile);
    saveConfig(config);
  } catch (err) {
    p.cancel(`Couldn't finish writing your setup.\n  ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  const zshrc = !rc.changed
    ? "managed block already up to date"
    : rc.replaced
      ? "managed block updated in place"
      : "3-line managed block added";
  p.note(
    [
      `${pc.dim("config".padEnd(10))} ${tilde(CONFIG_DIR)}`,
      `${pc.dim("zshrc".padEnd(10))} ${tilde(env.rcFile)} — ${zshrc}`,
      ...(rc.backup ? [`${pc.dim("backup".padEnd(10))} ${tilde(rc.backup)}`] : []),
      `${pc.dim("yours".padEnd(10))} ${tilde(CONFIG_DIR + "/custom.zsh")} ${pc.dim("(never overwritten)")}`,
    ].join("\n"),
    "Done",
  );

  p.outro(`Restart your shell to see it:  ${pc.cyan("exec zsh")}`);
}
