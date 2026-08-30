import { execFileSync } from "node:child_process";
import { has, type PackageManager } from "./detect.js";
import { packageFor, type Tool } from "./tools.js";

export interface InstallResult {
  installed: string[];
  alreadyPresent: string[];
  failed: string[];
  unsupported: string[];
  command: string | null;
}

function installCommand(pm: PackageManager, pkgs: string[]): [string, string[]] | null {
  switch (pm) {
    case "brew": return ["brew", ["install", ...pkgs]];
    case "apt": return ["sudo", ["apt-get", "install", "-y", ...pkgs]];
    case "dnf": return ["sudo", ["dnf", "install", "-y", ...pkgs]];
    case "pacman": return ["sudo", ["pacman", "-S", "--noconfirm", ...pkgs]];
    default: return null;
  }
}

/**
 * One package-manager invocation for everything missing — far faster than one
 * per tool, and it lets the manager resolve shared dependencies once.
 */
export function installTools(tools: Tool[], pm: PackageManager): InstallResult {
  const result: InstallResult = { installed: [], alreadyPresent: [], failed: [], unsupported: [], command: null };

  const wanted: Tool[] = [];
  for (const tool of tools) {
    if (has(tool.bin)) { result.alreadyPresent.push(tool.id); continue; }
    if (!packageFor(tool, pm)) { result.unsupported.push(tool.id); continue; }
    wanted.push(tool);
  }
  if (wanted.length === 0) return result;

  const pkgs = wanted.map((t) => packageFor(t, pm)!);
  const cmd = installCommand(pm, pkgs);
  if (!cmd) {
    result.unsupported.push(...wanted.map((t) => t.id));
    return result;
  }

  result.command = [cmd[0], ...cmd[1]].join(" ");
  try {
    execFileSync(cmd[0], cmd[1], { stdio: ["ignore", "pipe", "pipe"], timeout: 15 * 60 * 1000 });
  } catch {
    /* Partial success is normal — one bad formula shouldn't discard the rest,
       so we judge each tool by whether its binary is now on PATH. */
  }

  for (const tool of wanted) (has(tool.bin) ? result.installed : result.failed).push(tool.id);
  return result;
}

export function applyGitConfig(entries: [string, string][]): boolean {
  try {
    for (const [key, value] of entries) {
      execFileSync("git", ["config", "--global", key, value], { stdio: "ignore" });
    }
    return true;
  } catch {
    return false;
  }
}
