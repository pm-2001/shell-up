import { RedisError, type Arg, type RedisConn, type Reply } from "./resp.js";

// ── Bytes and text ─────────────────────────────────────────────────────────

/** Keys are arbitrary bytes. Inside shellup they travel as latin1 strings: one char per byte, lossless. */
export const toId = (b: Buffer): string => b.toString("latin1");
export const idBuf = (id: string): Buffer => Buffer.from(id, "latin1");

/** C0 and C1 control characters, bar newline and tab: the ones a terminal would act on. */
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/;

/** Whether the bytes read as ordinary UTF-8 text (newlines and tabs allowed). */
export function isText(b: Buffer): boolean {
  const text = b.toString("utf8");
  return !text.includes("�") && !CONTROL.test(text);
}

/**
 * Bytes as something safe to print. Valid UTF-8 stays as it is; anything else is
 * escaped, so a cached value can never smuggle terminal escape codes onto the screen.
 */
export function printable(b: Buffer): string {
  if (isText(b)) return b.toString("utf8");
  let out = "";
  for (const byte of b) {
    if (byte === 0x0a) out += "\\n";
    else if (byte === 0x09) out += "\\t";
    else if (byte === 0x0d) out += "\\r";
    else if (byte >= 0x20 && byte < 0x7f) out += String.fromCharCode(byte);
    else out += "\\x" + byte.toString(16).padStart(2, "0");
  }
  return out;
}

export function str(r: Reply | undefined): string {
  if (r === null || r === undefined) return "";
  if (Buffer.isBuffer(r)) return r.toString("utf8");
  if (r instanceof RedisError) return r.message;
  if (Array.isArray(r)) return r.map(str).join(" ");
  return String(r);
}
export const num = (r: Reply | undefined): number => (typeof r === "number" ? r : Number(str(r)) || 0);
export const asBuf = (r: Reply | undefined): Buffer => (Buffer.isBuffer(r) ? r : Buffer.from(str(r)));
export const asList = (r: Reply | undefined): Reply[] => (Array.isArray(r) ? r : []);

/** Pretty-printed JSON when the text is a JSON object or array, otherwise null. */
export function prettyJson(text: string): string | null {
  const t = text.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return null;
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return null;
  }
}

/** How a stored value should read: pretty JSON, plain text, or a hex dump for binary data. */
export function valueText(b: Buffer): string {
  if (!isText(b)) return hexdump(b);
  const text = b.toString("utf8");
  return prettyJson(text) ?? text;
}

export function hexdump(b: Buffer): string {
  const lines: string[] = [];
  for (let off = 0; off < b.length; off += 16) {
    const chunk = [...b.subarray(off, off + 16)];
    const hex = chunk.map((x) => x.toString(16).padStart(2, "0")).join(" ").padEnd(47);
    const ascii = chunk.map((x) => (x >= 0x20 && x < 0x7f ? String.fromCharCode(x) : ".")).join("");
    lines.push(`${off.toString(16).padStart(8, "0")}  ${hex}  ${ascii}`);
  }
  return lines.join("\n");
}

// ── Patterns ───────────────────────────────────────────────────────────────

const escapeRe = (c: string) => c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
export const escapeGlob = (s: string) => s.replace(/[*?[\]\\]/g, "\\$&");

/** Redis glob (* ? [abc] [^a] \x) as a RegExp over key ids, so live events can be tested against the filter. */
export function globToRegExp(glob: string): RegExp {
  const g = Buffer.from(glob, "utf8").toString("latin1");
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === "*") re += "[\\s\\S]*";
    else if (c === "?") re += "[\\s\\S]";
    else if (c === "\\" && i + 1 < g.length) re += escapeRe(g[++i]!);
    else if (c === "[") {
      const close = g.indexOf("]", i + 1);
      if (close === -1) {
        re += "\\[";
        continue;
      }
      let body = g.slice(i + 1, close);
      const negate = body.startsWith("^");
      if (negate) body = body.slice(1);
      re += `[${negate ? "^" : ""}${body.replace(/[\\\]]/g, "\\$&")}]`;
      i = close;
    } else re += escapeRe(c);
  }
  return new RegExp(`^${re}$`);
}

// ── Keys ───────────────────────────────────────────────────────────────────

/**
 * shellup's own key lookups. Redis counts every key read as one hit (key exists)
 * or one miss (it doesn't), MEMORY USAGE aside, so a browser that just looks
 * would inflate your hit rate. Counting them here lets the app subtract them.
 */
export interface Tally {
  hits: number;
  misses: number;
}

export function tally(t: Tally | undefined, exists: boolean, reads: number): void {
  if (!t || reads <= 0) return;
  if (exists) t.hits += reads;
  else t.misses += reads;
}


/** SCAN, never KEYS: it walks the keyspace in steps instead of blocking Redis while it lists everything. */
export async function scanKeys(conn: RedisConn, match: string, limit: number): Promise<{ ids: string[]; truncated: boolean }> {
  const found = new Set<string>();
  let cursor = "0";
  do {
    const reply = asList(await conn.call("SCAN", cursor, "MATCH", Buffer.from(match, "utf8"), "COUNT", 1000));
    cursor = str(reply[0]);
    for (const key of asList(reply[1])) {
      found.add(toId(asBuf(key)));
      if (found.size >= limit) return { ids: [...found], truncated: true };
    }
  } while (cursor !== "0");
  return { ids: [...found], truncated: false };
}

export interface KeyMeta {
  type: string;
  /** Milliseconds left when fetched: -1 means no expiry, -2 means the key is gone. */
  ttlMs: number;
  at: number;
  bytes: number | null;
  size: number | null;
}

const SIZE: Record<string, string> = {
  string: "STRLEN", hash: "HLEN", list: "LLEN", set: "SCARD", zset: "ZCARD", stream: "XLEN", vectorset: "VCARD",
};

/** Type, TTL, memory and length for many keys in two pipelined round trips. */
export async function fetchMeta(conn: RedisConn, ids: string[], own?: Tally): Promise<Map<string, KeyMeta>> {
  const out = new Map<string, KeyMeta>();
  if (!ids.length) return out;
  const at = Date.now();
  const base = await conn.pipeline(ids.flatMap((id) => [["TYPE", idBuf(id)], ["PTTL", idBuf(id)], ["MEMORY", "USAGE", idBuf(id)]]));
  const types = ids.map((_, i) => str(base[i * 3]));
  types.forEach((type) => tally(own, type !== "none", 2)); // TYPE and PTTL; MEMORY USAGE isn't counted
  const sizeCommands: Arg[][] = [];
  const sizeFor: number[] = [];
  ids.forEach((id, i) => {
    const cmd = SIZE[types[i]!];
    if (cmd) {
      sizeFor.push(i);
      sizeCommands.push([cmd, idBuf(id)]);
    }
  });
  const sizes = await conn.pipeline(sizeCommands);
  tally(own, true, sizeCommands.length);
  const size = new Map<number, number>();
  sizeFor.forEach((i, j) => {
    const r = sizes[j];
    if (typeof r === "number") size.set(i, r);
  });
  ids.forEach((id, i) => {
    const ttl = base[i * 3 + 1];
    const mem = base[i * 3 + 2];
    out.set(id, {
      type: types[i]!,
      ttlMs: typeof ttl === "number" ? ttl : -1,
      at,
      bytes: typeof mem === "number" ? mem : null,
      size: size.get(i) ?? null,
    });
  });
  return out;
}

// ── Values ─────────────────────────────────────────────────────────────────

export type Value =
  | { kind: "string"; data: Buffer; total: number }
  | { kind: "hash"; rows: { field: Buffer; value: Buffer; ttlMs: number | null }[]; total: number; at: number }
  | { kind: "list"; rows: Buffer[]; total: number }
  | { kind: "set"; rows: Buffer[]; total: number }
  | { kind: "zset"; rows: { member: Buffer; score: string }[]; total: number }
  | { kind: "stream"; rows: { id: string; fields: [Buffer, Buffer][] }[]; total: number; groups: number | null }
  | { kind: "json"; text: string }
  | { kind: "timeseries"; rows: { at: number; value: string }[] }
  | { kind: "vectorset"; rows: Buffer[]; total: number; dim: number | null }
  | { kind: "other"; type: string }
  | { kind: "missing" };

export const VALUE_LIMIT = 500;
const STRING_CAP = 256 * 1024;

/** An HSCAN/SSCAN run to completion, or until `max` items. */
async function scanCollection(conn: RedisConn, cmd: string, key: Buffer, max: number, own?: Tally): Promise<Buffer[]> {
  const items: Buffer[] = [];
  let cursor = "0";
  do {
    const reply = asList(await conn.call(cmd, key, cursor, "COUNT", 500));
    tally(own, true, 1);
    cursor = str(reply[0]);
    for (const item of asList(reply[1])) items.push(asBuf(item));
  } while (cursor !== "0" && items.length < max);
  return items;
}

/** A key's value, capped at `limit` elements (and 256 KB for strings) so a huge key can't stall the screen. */
export async function fetchValue(conn: RedisConn, id: string, limit = VALUE_LIMIT, own?: Tally): Promise<Value> {
  const key = idBuf(id);
  const type = str(await conn.call("TYPE", key));
  tally(own, type !== "none", 1);
  const reads = (n: number) => tally(own, true, n);
  switch (type) {
    case "none":
      return { kind: "missing" };
    case "string": {
      const [len, data] = await conn.pipeline([["STRLEN", key], ["GETRANGE", key, 0, STRING_CAP - 1]]);
      reads(2);
      return { kind: "string", data: asBuf(data), total: num(len) };
    }
    case "hash": {
      const total = num(await conn.call("HLEN", key));
      reads(1);
      const flat = await scanCollection(conn, "HSCAN", key, limit * 2, own);
      const seen = new Set<string>();
      const rows: { field: Buffer; value: Buffer; ttlMs: number | null }[] = [];
      for (let i = 0; i + 1 < flat.length && rows.length < limit; i += 2) {
        const field = flat[i]!;
        if (seen.has(toId(field))) continue;
        seen.add(toId(field));
        rows.push({ field, value: flat[i + 1]!, ttlMs: null });
      }
      // Per-field TTLs (HEXPIRE) exist from Redis 7.4; older servers reject HPTTL and it's skipped.
      if (rows.length) {
        const ttls = await conn.call("HPTTL", key, "FIELDS", rows.length, ...rows.map((r) => r.field)).catch(() => null);
        if (ttls !== null) reads(1);
        asList(ttls).forEach((t, i) => {
          if (typeof t === "number" && t >= 0 && rows[i]) rows[i]!.ttlMs = t;
        });
      }
      return { kind: "hash", rows, total, at: Date.now() };
    }
    case "list": {
      const [len, items] = await conn.pipeline([["LLEN", key], ["LRANGE", key, 0, limit - 1]]);
      reads(2);
      return { kind: "list", rows: asList(items).map(asBuf), total: num(len) };
    }
    case "set": {
      const total = num(await conn.call("SCARD", key));
      reads(1);
      const seen = new Set<string>();
      const rows: Buffer[] = [];
      for (const member of await scanCollection(conn, "SSCAN", key, limit, own)) {
        if (rows.length >= limit || seen.has(toId(member))) continue;
        seen.add(toId(member));
        rows.push(member);
      }
      return { kind: "set", rows, total };
    }
    case "zset": {
      const [len, flat] = await conn.pipeline([["ZCARD", key], ["ZRANGE", key, 0, limit - 1, "WITHSCORES"]]);
      reads(2);
      const items = asList(flat);
      const rows: { member: Buffer; score: string }[] = [];
      for (let i = 0; i + 1 < items.length; i += 2) rows.push({ member: asBuf(items[i]), score: str(items[i + 1]) });
      return { kind: "zset", rows, total: num(len) };
    }
    case "stream": {
      const [len, entries, groups] = await conn.pipeline([
        ["XLEN", key],
        ["XREVRANGE", key, "+", "-", "COUNT", limit],
        ["XINFO", "GROUPS", key],
      ]);
      reads(3);
      const rows = asList(entries).map((entry) => {
        const [entryId, flat] = asList(entry);
        const f = asList(flat);
        const fields: [Buffer, Buffer][] = [];
        for (let i = 0; i + 1 < f.length; i += 2) fields.push([asBuf(f[i]), asBuf(f[i + 1])]);
        return { id: str(entryId), fields };
      });
      return { kind: "stream", rows, total: num(len), groups: Array.isArray(groups) ? groups.length : null };
    }
    case "ReJSON-RL": {
      const text = str(await conn.call("JSON.GET", key));
      reads(1);
      return { kind: "json", text: prettyJson(text) ?? text };
    }
    case "TSDB-TYPE": {
      const points = asList(await conn.call("TS.REVRANGE", key, "-", "+", "COUNT", limit));
      reads(1);
      return {
        kind: "timeseries",
        rows: points.map((p) => {
          const [ts, v] = asList(p);
          return { at: num(ts), value: str(v) };
        }),
      };
    }
    case "vectorset": {
      const [card, dim, members] = await conn.pipeline([["VCARD", key], ["VDIM", key], ["VRANDMEMBER", key, limit]]);
      reads(3);
      return { kind: "vectorset", rows: asList(members).map(asBuf), total: num(card), dim: typeof dim === "number" ? dim : null };
    }
    default:
      return { kind: "other", type };
  }
}

// ── Changing things ────────────────────────────────────────────────────────

export async function deleteKeys(conn: RedisConn, ids: string[]): Promise<number> {
  let removed = 0;
  for (let i = 0; i < ids.length; i += 500) {
    const batch = ids.slice(i, i + 500).map(idBuf);
    let reply: Reply;
    try {
      reply = await conn.call("UNLINK", ...batch);
    } catch (err) {
      // UNLINK (DEL that frees memory in the background) arrived in Redis 4.
      if (!(err instanceof RedisError) || !/unknown command/i.test(err.message)) throw err;
      reply = await conn.call("DEL", ...batch);
    }
    removed += num(reply);
  }
  return removed;
}

export async function deleteMatching(conn: RedisConn, match: string): Promise<number> {
  const { ids } = await scanKeys(conn, match, Number.POSITIVE_INFINITY);
  return deleteKeys(conn, ids);
}

/** null removes the expiry. Returns false when there was nothing to change. */
export async function setTtl(conn: RedisConn, id: string, seconds: number | null): Promise<boolean> {
  const reply = seconds === null ? await conn.call("PERSIST", idBuf(id)) : await conn.call("EXPIRE", idBuf(id), seconds);
  return num(reply) === 1;
}

/** RENAMENX: never overwrites an existing key. Returns false if the new name is taken. */
export async function renameKey(conn: RedisConn, id: string, to: string): Promise<boolean> {
  return num(await conn.call("RENAMENX", idBuf(id), Buffer.from(to, "utf8"))) === 1;
}

/** KEEPTTL, so editing a cached value doesn't quietly make it permanent. */
export async function setString(conn: RedisConn, id: string, value: string): Promise<void> {
  await conn.call("SET", idBuf(id), Buffer.from(value, "utf8"), "KEEPTTL");
}

export async function publish(conn: RedisConn, channel: string, message: string): Promise<number> {
  return num(await conn.call("PUBLISH", Buffer.from(channel, "utf8"), Buffer.from(message, "utf8")));
}

/** "90", "5m", "2h", "1d", "1h30m" → seconds; "none" → null (no expiry); anything else → undefined. */
export function parseDuration(input: string): number | null | undefined {
  const s = input.trim().toLowerCase().replace(/\s+/g, "");
  if (["none", "persist", "never", "-1", "0"].includes(s)) return null;
  if (/^\d+$/.test(s)) return Number(s);
  const unit: Record<string, number> = { d: 86400, h: 3600, m: 60, s: 1 };
  if (!/^(\d+[dhms])+$/.test(s)) return undefined;
  let total = 0;
  for (const [, n, u] of s.matchAll(/(\d+)([dhms])/g)) total += Number(n) * unit[u!]!;
  return total > 0 ? total : undefined;
}

// ── Server ─────────────────────────────────────────────────────────────────

export type Info = Record<string, Record<string, string>>;

export function parseInfo(text: string): Info {
  const info: Info = {};
  let section = "";
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) {
      section = line.slice(1).trim().toLowerCase();
      info[section] ??= {};
      continue;
    }
    const i = line.indexOf(":");
    if (i === -1) continue;
    (info[section] ??= {})[line.slice(0, i)] = line.slice(i + 1);
  }
  return info;
}

/** "keys=12,expires=3" → { keys: "12", expires: "3" } */
export function fields(s: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (s ?? "").split(",")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}

export function keyspace(info: Info): Map<number, { keys: number; expires: number; avgTtl: number }> {
  const out = new Map<number, { keys: number; expires: number; avgTtl: number }>();
  for (const [name, value] of Object.entries(info.keyspace ?? {})) {
    const m = /^db(\d+)$/.exec(name);
    if (!m) continue;
    const f = fields(value);
    out.set(Number(m[1]), { keys: Number(f.keys ?? 0), expires: Number(f.expires ?? 0), avgTtl: Number(f.avg_ttl ?? 0) });
  }
  return out;
}

export function commandStats(info: Info): { name: string; calls: number; usecPer: number }[] {
  return Object.entries(info.commandstats ?? {})
    .map(([name, value]) => {
      const f = fields(value);
      return { name: name.replace(/^cmdstat_/, "").toUpperCase(), calls: Number(f.calls ?? 0), usecPer: Number(f.usec_per_call ?? 0) };
    })
    .sort((a, b) => b.calls - a.calls);
}

export interface SlowEntry {
  at: number;
  micros: number;
  args: string[];
  client: string;
}

export function parseSlowlog(reply: Reply | undefined): SlowEntry[] {
  return asList(reply).flatMap((entry) => {
    const e = asList(entry);
    if (e.length < 4) return [];
    return [{ at: num(e[1]) * 1000, micros: num(e[2]), args: asList(e[3]).map((a) => printable(asBuf(a))), client: str(e[4]) }];
  });
}

export function parseClients(text: string): Record<string, string>[] {
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const out: Record<string, string> = {};
      for (const part of line.trim().split(" ")) {
        const i = part.indexOf("=");
        if (i > 0) out[part.slice(0, i)] = part.slice(i + 1);
      }
      return out;
    });
}

// ── MONITOR ────────────────────────────────────────────────────────────────

export interface MonitorLine {
  at: number;
  db: number;
  source: string;
  args: string[];
}

/** `1726640000.123456 [0 127.0.0.1:52411] "SET" "k" "v"` → its parts. */
export function parseMonitorLine(line: string): MonitorLine | null {
  const m = /^(\d+\.\d+) \[(\d+) ([^\]]*)\] ([\s\S]*)$/.exec(line);
  if (!m) return null;
  return { at: Math.round(Number(m[1]) * 1000), db: Number(m[2]), source: m[3]!, args: splitQuoted(m[4]!) };
}

/** MONITOR quotes every argument C-style ("…" with \" \\ \n \xHH); the bytes are put back and read as UTF-8. */
function splitQuoted(s: string): string[] {
  const ESC: Record<string, number> = { n: 10, r: 13, t: 9, a: 7, b: 8 };
  const args: string[] = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] !== '"') {
      i++;
      continue;
    }
    const bytes: number[] = [];
    let j = i + 1;
    for (; j < s.length && s[j] !== '"'; j++) {
      const c = s[j]!;
      if (c !== "\\" || j + 1 >= s.length) {
        bytes.push(...Buffer.from(c, "utf8"));
        continue;
      }
      const e = s[++j]!;
      if (e === "x" && j + 2 < s.length) {
        bytes.push(parseInt(s.slice(j + 1, j + 3), 16));
        j += 2;
      } else bytes.push(ESC[e] ?? e.charCodeAt(0));
    }
    args.push(printable(Buffer.from(bytes)));
    i = j + 1;
  }
  return args;
}

/** Commands whose first argument isn't a key. Everything else is taken to name its key first. */
const NO_KEY = new Set([
  "PING", "ECHO", "INFO", "SELECT", "AUTH", "HELLO", "CLIENT", "CONFIG", "MONITOR", "MULTI", "EXEC", "DISCARD",
  "UNWATCH", "SUBSCRIBE", "PSUBSCRIBE", "SSUBSCRIBE", "UNSUBSCRIBE", "PUNSUBSCRIBE", "PUBLISH", "SPUBLISH", "PUBSUB",
  "SCAN", "KEYS", "DBSIZE", "RANDOMKEY", "FLUSHDB", "FLUSHALL", "SAVE", "BGSAVE", "BGREWRITEAOF", "LASTSAVE", "TIME",
  "COMMAND", "SLOWLOG", "MEMORY", "LATENCY", "DEBUG", "SCRIPT", "FUNCTION", "EVAL", "EVALSHA", "EVAL_RO", "EVALSHA_RO",
  "FCALL", "FCALL_RO", "QUIT", "RESET", "SHUTDOWN", "SWAPDB", "WAIT", "WAITAOF", "ACL", "CLUSTER", "READONLY",
  "READWRITE", "ROLE", "REPLICAOF", "SLAVEOF", "SYNC", "PSYNC", "XREAD", "XREADGROUP", "OBJECT", "MODULE", "MIGRATE",
]);

export function keyOf(cmd: string, args: string[]): string | undefined {
  return NO_KEY.has(cmd) ? undefined : args[1];
}

// ── Formatting ─────────────────────────────────────────────────────────────

export function formatDuration(ms: number): string {
  if (ms < 1000) return "<1s";
  let s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  if (d) return h ? `${d}d${h}h` : `${d}d`;
  if (h) return `${h}h${String(m).padStart(2, "0")}m`;
  if (m) return `${m}m${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n;
  let u = -1;
  do {
    v /= 1024;
    u++;
  } while (v >= 1024 && u < units.length - 1);
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[u]}`;
}

export const formatCount = (n: number): string => n.toLocaleString("en-US");

/** A unix time in seconds as "4m ago". */
export function ago(unixSeconds: number): string {
  if (!unixSeconds) return "never";
  return `${formatDuration(Math.max(0, Date.now() - unixSeconds * 1000))} ago`;
}
