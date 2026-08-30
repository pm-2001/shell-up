import pc from "picocolors";

export const dim = pc.dim;
export const bold = pc.bold;
export const ok = (s: string) => pc.green(s);
export const warn = (s: string) => pc.yellow(s);
export const bad = (s: string) => pc.red(s);
export const accent = (s: string) => pc.cyan(s);

export const SYM = { ok: "✔", warn: "!", bad: "✖", info: "·" } as const;

export function banner(version: string): string {
  return `${pc.bgCyan(pc.black(" shellup "))} ${dim("v" + version)}`;
}

/** Left-aligned two-column rows, used by `doctor` and the init summary. */
export function rows(entries: [string, string][], pad = 16): string {
  return entries.map(([k, v]) => `  ${dim(k.padEnd(pad))} ${v}`).join("\n");
}
