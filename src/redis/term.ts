import pc from "picocolors";
import stringWidth from "fast-string-width";

export type Key = string;

const segmenter = new Intl.Segmenter();

/** Columns a string takes on screen. ANSI-aware, and counts wide characters (日本, emoji) as two. */
export const width = (text: string): number => stringWidth(text);

/** Text made safe and flat for one line: no newlines, tabs or control characters. */
export function oneLine(text: string): string {
  return text
    .replace(/\r?\n/g, "↵")
    .replace(/\t/g, "  ")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, "·");
}

/** Plain text cut to at most `w` columns, ending in … when anything was cut. */
export function clip(text: string, w: number): string {
  if (w <= 0) return "";
  if (stringWidth(text) <= w) return text;
  let out = "";
  let used = 0;
  for (const { segment } of segmenter.segment(text)) {
    const cw = stringWidth(segment);
    if (used + cw > w - 1) break;
    out += segment;
    used += cw;
  }
  return out + "…";
}

/** Plain text cut or padded to exactly `w` columns. */
export function cell(text: string, w: number, align: "left" | "right" = "left"): string {
  const t = clip(text, w);
  const pad = " ".repeat(Math.max(0, w - stringWidth(t)));
  return align === "right" ? pad + t : t + pad;
}

/** Long lines broken at the screen width, for reading a whole value. */
export function wrap(text: string, w: number): string[] {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const line = oneLine(raw);
    if (!line) {
      out.push("");
      continue;
    }
    let cur = "";
    let used = 0;
    for (const { segment } of segmenter.segment(line)) {
      const cw = stringWidth(segment);
      if (used + cw > w) {
        out.push(cur);
        cur = "";
        used = 0;
      }
      cur += segment;
      used += cw;
    }
    out.push(cur);
  }
  return out;
}

export type Seg = [text: string, style?: (s: string) => string];

/** A line exactly `w` wide from styled pieces: `left` packed from the start, `right` pinned to the end. */
export function bar(left: Seg[], right: Seg[], w: number): string {
  const rightW = right.reduce((n, [t]) => n + stringWidth(t), 0);
  const showRight = rightW <= w;
  const room = showRight ? w - rightW : w;
  let out = "";
  let used = 0;
  for (const [text, style] of left) {
    const tw = stringWidth(text);
    if (used + tw > room) {
      const c = clip(text, room - used);
      if (c) {
        out += style ? style(c) : c;
        used += stringWidth(c);
      }
      break;
    }
    out += style ? style(text) : text;
    used += tw;
  }
  const rightOut = showRight ? right.map(([t, s]) => (s ? s(t) : t)).join("") : "";
  return out + " ".repeat(Math.max(0, w - used - (showRight ? rightW : 0))) + rightOut;
}

/** A bordered panel exactly `w` × `h`. Body lines must already be exactly `w - 2` columns wide. */
export function box(title: string, note: string, body: string[], w: number, h: number, focused: boolean): string[] {
  const edge = focused ? pc.cyan : pc.dim;
  const inner = Math.max(0, w - 2);
  const t = clip(title, Math.max(0, inner - 4));
  const n = note ? clip(note, Math.max(0, inner - 8 - stringWidth(t))) : "";
  const noteW = n ? stringWidth(n) + 3 : 0;
  const fill = Math.max(0, inner - 3 - stringWidth(t) - noteW);
  const top = t
    ? edge("┌─ ") + (focused ? pc.bold(t) : t) + edge(" " + "─".repeat(fill)) + (n ? " " + pc.dim(n) + edge(" ─") : "") + edge("┐")
    : edge("┌" + "─".repeat(inner) + "┐");
  const lines = [top];
  for (let i = 0; i < h - 2; i++) lines.push(edge("│") + (body[i] ?? " ".repeat(inner)) + edge("│"));
  lines.push(edge("└" + "─".repeat(inner) + "┘"));
  return lines;
}

const ESC = String.fromCharCode(27);
const SEQUENCES: [string, Key][] = [
  ["[1;5A", "up"], ["[1;5B", "down"], ["[5~", "pageup"], ["[6~", "pagedown"],
  ["[1~", "home"], ["[4~", "end"], ["[3~", "delete"],
  ["[A", "up"], ["[B", "down"], ["[C", "right"], ["[D", "left"],
  ["OA", "up"], ["OB", "down"], ["OC", "right"], ["OD", "left"],
  ["[H", "home"], ["[F", "end"], ["OH", "home"], ["OF", "end"], ["[Z", "shift-tab"],
].map(([seq, name]) => [ESC + seq, name] as [string, Key]);

const CTRL: Record<number, Key> = { 13: "enter", 10: "enter", 9: "tab", 127: "backspace", 8: "backspace", 3: "ctrl-c", 12: "ctrl-l", 21: "ctrl-u", 1: "home", 5: "end" };

/** Raw terminal input → key names ("up", "enter", …) or the character typed. */
export function decodeKeys(data: string): Key[] {
  const keys: Key[] = [];
  let i = 0;
  outer: while (i < data.length) {
    if (data[i] === ESC) {
      for (const [seq, name] of SEQUENCES) {
        if (data.startsWith(seq, i)) {
          keys.push(name);
          i += seq.length;
          continue outer;
        }
      }
      if (data[i + 1] === "[") {
        // An escape sequence this app has no use for: skip the whole thing.
        let j = i + 2;
        while (j < data.length && !/[@-~]/.test(data[j]!)) j++;
        i = j + 1;
        continue;
      }
      keys.push("escape");
      i++;
      continue;
    }
    const code = data.codePointAt(i)!;
    const ch = String.fromCodePoint(code);
    i += ch.length;
    if (CTRL[code]) keys.push(CTRL[code]!);
    else if (code >= 32) keys.push(ch);
  }
  return keys;
}

const CSI = ESC + "[";

/** Full-screen output on the terminal's alternate screen, redrawing only the lines that changed. */
export class Screen {
  private prev: string[] = [];
  private active = false;
  private keyHandler: (k: Key) => void = () => undefined;
  private resizeHandler: () => void = () => undefined;
  private readonly onData = (data: string) => {
    for (const k of decodeKeys(data)) this.keyHandler(k);
  };
  private readonly onResize = () => {
    this.prev = [];
    process.stdout.write(`${CSI}2J`);
    this.resizeHandler();
  };

  get cols(): number {
    return process.stdout.columns || 80;
  }
  get rows(): number {
    return process.stdout.rows || 24;
  }

  start(onKey: (k: Key) => void, onResize: () => void): void {
    this.keyHandler = onKey;
    this.resizeHandler = onResize;
    this.active = true;
    process.stdout.write(`${CSI}?1049h${CSI}?25l${CSI}2J`);
    process.stdin.setRawMode(true);
    process.stdin.setEncoding("utf8");
    process.stdin.resume();
    process.stdin.on("data", this.onData);
    process.stdout.on("resize", this.onResize);
  }

  /** Gives the terminal back exactly as it was: main screen, cursor, cooked input. */
  stop(): void {
    if (!this.active) return;
    this.active = false;
    process.stdin.off("data", this.onData);
    process.stdout.off("resize", this.onResize);
    try {
      process.stdin.setRawMode(false);
    } catch {
      /* stdin already gone */
    }
    process.stdin.pause();
    process.stdout.write(`${CSI}0m${CSI}?25h${CSI}?1049l`);
  }

  /** Lines must be at most cols - 1 wide: writing the last column can make some terminals scroll. */
  draw(lines: string[]): void {
    if (!this.active) return;
    let out = "";
    for (let i = 0; i < this.rows; i++) {
      const line = lines[i] ?? "";
      if (line !== this.prev[i]) out += `${CSI}${i + 1};1H${CSI}0m${line}${CSI}0m${CSI}K`;
    }
    this.prev = lines.slice(0, this.rows);
    if (out) process.stdout.write(out);
  }

  invalidate(): void {
    this.prev = [];
  }
}
