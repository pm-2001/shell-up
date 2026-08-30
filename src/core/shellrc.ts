import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { BACKUP_DIR, INIT_FILE, tilde } from "./paths.js";

const START = "# >>> shellup >>>";
const END = "# <<< shellup <<<";

/**
 * The only thing shellup ever adds to your rc file. Everything else lives in
 * ~/.config/shellup, so the footprint in a file you also hand-edit is 3 lines.
 */
function block(): string {
  return [
    START,
    "# Managed by shellup — edit ~/.config/shellup/config.json, then run `shellup apply`.",
    `[ -f "${INIT_FILE.replace(process.env.HOME ?? "", "$HOME")}" ] && source "${INIT_FILE.replace(process.env.HOME ?? "", "$HOME")}"`,
    END,
  ].join("\n");
}

export function hasBlock(rcFile: string): boolean {
  return existsSync(rcFile) && readFileSync(rcFile, "utf8").includes(START);
}

/**
 * Timestamped copy of the rc file before we touch it. Cheap insurance, and it
 * gives `shellup uninstall` something to point at if the user wants the
 * pre-shellup file back verbatim.
 */
export function backupRc(rcFile: string): string | null {
  if (!existsSync(rcFile)) return null;
  mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = join(BACKUP_DIR, `zshrc.${stamp}.bak`);
  copyFileSync(rcFile, dest);
  return dest;
}

function stripBlock(content: string): string {
  const lines = content.split("\n");
  const out: string[] = [];
  let inside = false;
  for (const line of lines) {
    if (line.trim() === START) {
      inside = true;
      // installBlock adds a blank spacer line before the block; take it back out
      // so an install/uninstall round-trip returns the file byte-for-byte.
      if (out.length && out[out.length - 1]!.trim() === "") out.pop();
      continue;
    }
    if (line.trim() === END) { inside = false; continue; }
    if (!inside) out.push(line);
  }
  return out.join("\n");
}

/** Idempotent: replaces an existing block in place, or appends a new one. */
export function installBlock(rcFile: string): { backup: string | null; replaced: boolean } {
  const existed = existsSync(rcFile);
  const original = existed ? readFileSync(rcFile, "utf8") : "";
  const replaced = original.includes(START);
  const backup = backupRc(rcFile);

  let next = replaced ? stripBlock(original) : original;
  if (next.length && !next.endsWith("\n")) next += "\n";
  next += (next.trim() ? "\n" : "") + block() + "\n";

  writeFileSync(rcFile, next, "utf8");
  return { backup, replaced };
}

export function removeBlock(rcFile: string): { backup: string | null; removed: boolean } {
  if (!hasBlock(rcFile)) return { backup: null, removed: false };
  const backup = backupRc(rcFile);
  writeFileSync(rcFile, stripBlock(readFileSync(rcFile, "utf8")), "utf8");
  return { backup, removed: true };
}

export const describeBlock = () => `3 lines in ${tilde("~/.zshrc")}`;
