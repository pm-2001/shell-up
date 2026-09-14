import { spawnSync } from "node:child_process";
import { has, type PackageManager } from "./detect.js";
import { isPresent, packageFor, type Tool } from "./tools.js";

/** The user pressed Ctrl-C while the package manager was running. */
export class InstallInterrupted extends Error {
  constructor() {
    super("Install interrupted.");
  }
}

export interface InstallResult {
  installed: string[];
  alreadyPresent: string[];
  failed: string[];
  unsupported: string[];
  /** Commands to retry by hand, covering only what failed. */
  retry: string[];
  /** The package manager needs root, this isn't root, and there's no sudo. */
  noSudo: boolean;
}

function elevated(argv: string[]): string[] | null {
  if (process.getuid?.() === 0) return argv;
  return has("sudo") ? ["sudo", ...argv] : null;
}

function commandFor(pm: PackageManager, pkgs: string[]): string[] | null {
  switch (pm) {
    case "brew": return ["brew", "install", ...pkgs];
    case "apt": return elevated(["apt-get", "install", "-y", ...pkgs]);
    case "dnf": return elevated(["dnf", "install", "-y", ...pkgs]);
    case "pacman": return elevated(["pacman", "-S", "--noconfirm", "--needed", ...pkgs]);
    default: return null;
  }
}

/**
 * Runs in the foreground with the terminal handed over, not behind a spinner: a
 * sudo password prompt needs a working terminal, and Ctrl-C has to reach the
 * package manager rather than be swallowed.
 */
function run(argv: string[]): void {
  const result = spawnSync(argv[0]!, argv.slice(1), { stdio: "inherit" });
  if (result.signal === "SIGINT" || result.status === 130) throw new InstallInterrupted();
}

export function installTools(tools: Tool[], pm: PackageManager): InstallResult {
  const result: InstallResult = {
    installed: [], alreadyPresent: [], failed: [], unsupported: [], retry: [], noSudo: false,
  };

  const wanted: Tool[] = [];
  for (const tool of tools) {
    if (isPresent(tool)) { result.alreadyPresent.push(tool.id); continue; }
    if (!packageFor(tool, pm)) { result.unsupported.push(tool.id); continue; }
    wanted.push(tool);
  }
  if (wanted.length === 0) return result;

  // brew carries on past a bad formula, so one call is fastest. apt, dnf and pacman
  // abort the whole transaction over a single unknown package (eza isn't packaged on
  // Debian 12 or Ubuntu 22.04), so there it's one package per call.
  const batches = pm === "brew" ? [wanted] : wanted.map((tool) => [tool]);
  for (const batch of batches) {
    const argv = commandFor(pm, batch.map((tool) => packageFor(tool, pm)!));
    if (!argv) {
      result.noSudo = true;
      result.failed.push(...batch.map((tool) => tool.id));
      continue;
    }
    run(argv);
    // Judge each tool by whether it's usable now, not by the exit code: a partial
    // brew run exits non-zero but still installs the rest.
    const failedHere = batch.filter((tool) => !isPresent(tool));
    for (const tool of batch) (failedHere.includes(tool) ? result.failed : result.installed).push(tool.id);
    if (failedHere.length) {
      const retry = commandFor(pm, failedHere.map((tool) => packageFor(tool, pm)!));
      if (retry) result.retry.push(retry.join(" "));
    }
  }
  return result;
}

export function gitConfigGet(key: string): string | null {
  const result = spawnSync("git", ["config", "--global", "--get", key], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.replace(/\n$/, "") : null;
}

/** null unsets the key. */
export function gitConfigSet(key: string, value: string | null): boolean {
  const args = value === null ? ["config", "--global", "--unset", key] : ["config", "--global", key, value];
  const result = spawnSync("git", args, { stdio: "ignore" });
  // --unset exits 5 when the key is already absent, which is the state we wanted.
  return result.status === 0 || (value === null && result.status === 5);
}

/** Applies the settings and returns what each key held before (null = unset), or null on failure. */
export function applyGitConfig(entries: [string, string][]): Record<string, string | null> | null {
  const previous: Record<string, string | null> = {};
  for (const [key] of entries) previous[key] = gitConfigGet(key);
  for (const [key, value] of entries) if (!gitConfigSet(key, value)) return null;
  return previous;
}
