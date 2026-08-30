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

/** Render an absolute path with `~` so wizard output stays narrow. */
export function tilde(p: string): string {
  return p.startsWith(HOME) ? "~" + p.slice(HOME.length) : p;
}
