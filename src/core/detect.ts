import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, basename } from "node:path";

export type PackageManager = "brew" | "apt" | "dnf" | "pacman" | "none";

export interface Environment {
  os: "macos" | "linux" | "other";
  shell: string;
  isZsh: boolean;
  rcFile: string;
  packageManager: PackageManager;
  nerdFont: boolean;
  terminal: string;
  trueColor: boolean;
}

/** `which`, minus the throw. Used everywhere to decide if a tool is present. */
export function has(bin: string): boolean {
  try {
    execFileSync("command", ["-v", bin], { stdio: "ignore", shell: "/bin/sh" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Zsh plugins ship as a sourceable file, not a binary, so `command -v` can't see
 * them. Package managers disagree about where they land, hence a candidate list.
 */
export function hasFile(paths: string[]): boolean {
  const prefix = process.env.HOMEBREW_PREFIX ?? "/opt/homebrew";
  return paths.some((path) => existsSync(path.replace("${HOMEBREW_PREFIX:-/opt/homebrew}", prefix)));
}

function detectPackageManager(): PackageManager {
  for (const pm of ["brew", "apt", "dnf", "pacman"] as const) if (has(pm)) return pm;
  return "none";
}

/**
 * Powerline and neon draw with glyphs that only exist in a patched font. Getting
 * this wrong shows the user a prompt full of tofu boxes, so we check rather than
 * assume, and fall back to the glyph-free theme when unsure.
 */
function detectNerdFont(): boolean {
  const os = platform();
  if (os === "darwin") {
    const dirs = [join(homedir(), "Library", "Fonts"), "/Library/Fonts"];
    for (const dir of dirs) {
      if (!existsSync(dir)) continue;
      try {
        if (readdirSync(dir).some((f) => /nerd|nf-|powerline/i.test(basename(f)))) return true;
      } catch {
        /* unreadable font dir is not an error, just no evidence */
      }
    }
    return false;
  }
  try {
    const out = execFileSync("fc-list", [], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return /nerd font|powerline/i.test(out);
  } catch {
    return false;
  }
}

/**
 * zsh reads $ZDOTDIR/.zshrc when ZDOTDIR is set, and people usually set it in
 * ~/.zshenv without exporting it, so this process can't see it. A non-interactive
 * `zsh -c` still reads ~/.zshenv, so ask zsh itself.
 */
export function rcFilePath(): string {
  const fallback = join(process.env.ZDOTDIR || homedir(), ".zshrc");
  try {
    const out = execFileSync("zsh", ["-c", 'print -r -- "${ZDOTDIR:-$HOME}"'], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });
    // ~/.zshenv may print things of its own; the answer is the last line.
    const dir = out.trim().split("\n").pop()?.trim();
    return dir ? join(dir, ".zshrc") : fallback;
  } catch {
    return fallback;
  }
}

export function detect(): Environment {
  const os = platform();
  const shell = process.env.SHELL ?? "";
  const colorterm = process.env.COLORTERM ?? "";
  return {
    os: os === "darwin" ? "macos" : os === "linux" ? "linux" : "other",
    shell,
    isZsh: shell.includes("zsh"),
    rcFile: rcFilePath(),
    packageManager: detectPackageManager(),
    nerdFont: detectNerdFont(),
    terminal: process.env.TERM_PROGRAM ?? process.env.TERM ?? "unknown",
    trueColor: colorterm === "truecolor" || colorterm === "24bit",
  };
}
