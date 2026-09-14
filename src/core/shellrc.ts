import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { BACKUP_DIR, INIT_FILE, tilde, toShellPath } from "./paths.js";

const START = "# >>> shellup >>>";
const END = "# <<< shellup <<<";

/** The rc file is in a shape shellup won't edit. The message is written for the user. */
export class RcFileError extends Error {}

/**
 * The only thing shellup ever adds to your rc file. Everything else lives in
 * ~/.config/shellup, so the footprint in a file you also hand-edit is 3 lines.
 */
function blockLines(): string[] {
  const init = toShellPath(INIT_FILE);
  return [
    START,
    "# Managed by shellup — edit ~/.config/shellup/config.json, then run `shellup apply`.",
    `[ -f "${init}" ] && source "${init}"`,
    END,
  ];
}

interface Span {
  start: number;
  end: number;
}

type Scan = { ok: true; spans: Span[] } | { ok: false; line: number };

/**
 * Markers count only as whole lines, with the same test everywhere, so a
 * commented-out or quoted copy of the marker text is never taken for the block.
 * A start with no end (or a second start before the end) is reported, never
 * guessed at: guessing is how everything after the marker used to get deleted.
 */
function scan(lines: string[]): Scan {
  const spans: Span[] = [];
  let open = -1;
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]!.trim();
    if (text === START) {
      if (open !== -1) return { ok: false, line: open + 1 };
      open = i;
    } else if (text === END && open !== -1) {
      spans.push({ start: open, end: i });
      open = -1;
    }
  }
  return open === -1 ? { ok: true, spans } : { ok: false, line: open + 1 };
}

function malformed(rcFile: string, line: number): RcFileError {
  return new RcFileError(
    `${tilde(rcFile)} has a "${START}" line (line ${line}) with no "${END}" after it.\n` +
      `  shellup can't tell where its block ends, so it won't edit the file and risk your lines.\n` +
      `  Put the end marker back, or delete the start marker, then run this again.`,
  );
}

export type BlockState = "present" | "absent" | { malformedAt: number };

export function inspectBlock(rcFile: string): BlockState {
  if (!existsSync(rcFile)) return "absent";
  const result = scan(readFileSync(rcFile, "utf8").split("\n"));
  if (!result.ok) return { malformedAt: result.line };
  return result.spans.length ? "present" : "absent";
}

export function hasBlock(rcFile: string): boolean {
  return inspectBlock(rcFile) === "present";
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

/**
 * Idempotent. An existing block is rewritten where it already sits: moving it to
 * the end would put shellup after config you deliberately placed below it, and let
 * it override your prompt or plugins. With no block, one is appended.
 */
export function installBlock(rcFile: string): { backup: string | null; replaced: boolean; changed: boolean } {
  const original = existsSync(rcFile) ? readFileSync(rcFile, "utf8") : "";
  const lines = original.split("\n");
  const result = scan(lines);
  if (!result.ok) throw malformed(rcFile, result.line);

  let next: string;
  const replaced = result.spans.length > 0;
  if (replaced) {
    const out = [...lines];
    // Drop any extra copies from the bottom up so earlier indices stay valid, then
    // rewrite the first block in place.
    for (const span of result.spans.slice(1).reverse()) out.splice(span.start, span.end - span.start + 1);
    const first = result.spans[0]!;
    out.splice(first.start, first.end - first.start + 1, ...blockLines());
    next = out.join("\n");
  } else {
    next = original;
    if (next.length && !next.endsWith("\n")) next += "\n";
    next += (next.trim() ? "\n" : "") + blockLines().join("\n") + "\n";
  }

  // Nothing to change means nothing to back up: `apply` shouldn't pile up copies.
  if (next === original) return { backup: null, replaced, changed: false };
  const backup = backupRc(rcFile);
  writeFileSync(rcFile, next, "utf8");
  return { backup, replaced, changed: true };
}

export function removeBlock(rcFile: string): { backup: string | null; removed: boolean } {
  if (!existsSync(rcFile)) return { backup: null, removed: false };
  const original = readFileSync(rcFile, "utf8");
  const lines = original.split("\n");
  const result = scan(lines);
  if (!result.ok) throw malformed(rcFile, result.line);
  if (!result.spans.length) return { backup: null, removed: false };

  const out = [...lines];
  for (const span of [...result.spans].reverse()) {
    let start = span.start;
    // installBlock adds one blank spacer line before an appended block; take it back
    // out so an install/uninstall round-trip returns the file byte-for-byte.
    if (start > 0 && out[start - 1]!.trim() === "") start--;
    out.splice(start, span.end - start + 1);
  }
  const backup = backupRc(rcFile);
  writeFileSync(rcFile, out.join("\n"), "utf8");
  return { backup, removed: true };
}
