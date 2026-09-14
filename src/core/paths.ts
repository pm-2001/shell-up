import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HOME = homedir();

/** Root of the installed package, so we can read the shipped `runtime/` files. */
export const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Everything shellup owns lives under one directory. Uninstalling is then
 * "delete this folder + drop the managed block", with nothing left behind.
 */
export const CONFIG_DIR = process.env.SHELLUP_HOME ?? join(HOME, ".config", "shellup");
export const CONFIG_FILE = join(CONFIG_DIR, "config.json");
export const INIT_FILE = join(CONFIG_DIR, "init.zsh");
export const GENERATED_DIR = join(CONFIG_DIR, "generated");
export const RUNTIME_DIR = join(CONFIG_DIR, "runtime");
export const BACKUP_DIR = join(CONFIG_DIR, "backups");

export const home = () => HOME;

/** True for HOME itself or a path inside it. A bare prefix test would also match /Users/me2. */
function underHome(p: string): boolean {
  return p === HOME || p.startsWith(HOME + "/");
}

/** Render an absolute path with `~` so wizard output stays narrow. */
export function tilde(p: string): string {
  return underHome(p) ? "~" + p.slice(HOME.length) : p;
}

/** The same path as generated zsh should spell it: $HOME-relative when it lives under HOME. */
export function toShellPath(p: string): string {
  return underHome(p) ? "$HOME" + p.slice(HOME.length) : p;
}
