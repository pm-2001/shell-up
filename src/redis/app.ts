import pc from "picocolors";
import { spawnSync } from "node:child_process";
import { RedisConn, type Reply } from "./resp.js";
import { Screen, bar, box, cell, clip, oneLine, width, wrap, type Key, type Seg } from "./term.js";
import * as d from "./data.js";
import type { Target } from "./target.js";

type View = "keys" | "activity" | "server" | "pubsub";
const VIEWS: [View, string][] = [["keys", "Keys"], ["activity", "Activity"], ["server", "Server"], ["pubsub", "Pub/Sub"]];

interface Row {
  kind: "group" | "key";
  /** A key's id, or a group's prefix ("user:"). */
  id: string;
  label: string;
  /** What the row shows: the label without its parent group's prefix. */
  text: string;
  depth: number;
  count: number;
  open: boolean;
}

interface Entry {
  seq: number;
  at: number;
  got: number;
  db: number;
  kind: "cmd" | "event";
  source: string;
  cmd: string;
  args: string[];
  key?: string;
  search: string;
}

interface Message {
  at: number;
  channel: string;
  text: string;
}

interface ValueContent {
  head?: string;
  lines: string[];
  /** The whole entry for row i, built only when asked for (⏎ or copy). */
  detail: (i: number) => string;
  foot?: string;
}

export interface AppOptions {
  target: Target;
  readOnly: boolean;
  monitor: boolean;
}

const KEY_LIMIT = 50_000;
const ACTIVITY_LIMIT = 5_000;
const MESSAGE_LIMIT = 2_000;
/** With this few keys, every prefix group starts open. */
const AUTO_EXPAND = 40;
const FLASH_MS = 1_500;
/** Key events after which the key no longer exists. Popping a list's last item fires "del". */
const GONE = new Set(["del", "expired", "evicted", "rename_from", "move_from"]);

const TYPE_SHORT: Record<string, string> = { "ReJSON-RL": "json", "TSDB-TYPE": "tseries", "MBbloom--": "bloom", vectorset: "vset", none: "gone" };
const TYPE_COLOR: Record<string, (s: string) => string> = {
  string: pc.green, hash: pc.magenta, list: pc.blue, set: pc.cyan, zset: pc.yellow, stream: pc.red,
  "ReJSON-RL": pc.green, vectorset: pc.blue, none: pc.dim,
};
const UNIT: Record<string, string> = { hash: "fields", list: "items", set: "members", zset: "members", stream: "entries", vectorset: "vectors" };

const READ = /^(GET|MGET|GETRANGE|SUBSTR|GETEX|STRLEN|EXISTS|TTL|PTTL|EXPIRETIME|PEXPIRETIME|TYPE|HGET|HMGET|HGETALL|HKEYS|HVALS|HLEN|HEXISTS|HSTRLEN|HRANDFIELD|HSCAN|HTTL|HPTTL|LRANGE|LINDEX|LLEN|LPOS|SMEMBERS|SISMEMBER|SMISMEMBER|SCARD|SSCAN|SRANDMEMBER|SINTER|SUNION|SDIFF|ZRANGE|ZREVRANGE|ZRANGEBYSCORE|ZREVRANGEBYSCORE|ZRANGEBYLEX|ZSCORE|ZMSCORE|ZCARD|ZRANK|ZREVRANK|ZCOUNT|ZSCAN|XRANGE|XREVRANGE|XLEN|XREAD|XINFO|XPENDING|SCAN|KEYS|DBSIZE|RANDOMKEY|JSON\.GET|JSON\.MGET|TS\.RANGE|TS\.REVRANGE|TS\.GET|PFCOUNT|GETBIT|BITCOUNT|BITPOS|DUMP|OBJECT|MEMORY)$/;
const REMOVE = /^(DEL|UNLINK|GETDEL|EXPIRE|PEXPIRE|EXPIREAT|PEXPIREAT|LPOP|RPOP|BLPOP|BRPOP|LMPOP|BLMPOP|RPOPLPUSH|BRPOPLPUSH|LMOVE|BLMOVE|LREM|LTRIM|SPOP|SREM|SMOVE|ZPOPMIN|ZPOPMAX|BZPOPMIN|BZPOPMAX|ZMPOP|BZMPOP|ZREM|ZREMRANGEBYSCORE|ZREMRANGEBYRANK|ZREMRANGEBYLEX|HDEL|HGETDEL|HEXPIRE|HPEXPIRE|XDEL|XTRIM|XACK|FLUSHDB|FLUSHALL|JSON\.DEL|JSON\.FORGET)$/;
const WRITE = /^(SET|SETEX|PSETEX|SETNX|SETRANGE|MSET|MSETNX|GETSET|INCR|INCRBY|INCRBYFLOAT|DECR|DECRBY|APPEND|HSET|HMSET|HSETNX|HSETEX|HINCRBY|HINCRBYFLOAT|LPUSH|RPUSH|LPUSHX|RPUSHX|LSET|LINSERT|SADD|ZADD|ZINCRBY|XADD|XGROUP|JSON\.SET|JSON\.MERGE|TS\.ADD|TS\.MADD|PFADD|SETBIT|RENAME|RENAMENX|COPY|MOVE|PERSIST|RESTORE)$/;

/** Removals and pops red, writes green, reads cyan, everything else yellow. */
function commandStyle(cmd: string): (s: string) => string {
  if (REMOVE.test(cmd)) return pc.red;
  if (WRITE.test(cmd)) return pc.green;
  if (READ.test(cmd)) return pc.cyan;
  return pc.yellow;
}

const fmt = d.formatCount;
const pct = (x: number | null) => (x === null ? "–" : `${(x * 100).toFixed(x >= 0.9995 || x < 0.0005 ? 0 : 1)}%`);
const pad2 = (n: number) => String(n).padStart(2, "0");
const blank = (w: number) => " ".repeat(Math.max(0, w));
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

function clock(at: number): string {
  const t = new Date(at);
  return `${pad2(t.getHours())}:${pad2(t.getMinutes())}:${pad2(t.getSeconds())}.${String(t.getMilliseconds()).padStart(3, "0")}`;
}

function quoteArg(arg: string): string {
  const s = clip(oneLine(arg), 60);
  return s === "" || /[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
}

function fill(lines: string[], h: number, w: number): string[] {
  const out = lines.slice(0, h);
  while (out.length < h) out.push(blank(w));
  return out;
}

function centered(messages: string[], w: number, h: number): string[] {
  const top = Math.max(0, Math.floor((h - messages.length) / 2));
  const body = messages.map((m) => pc.dim(cell(blank(Math.floor((w - width(m)) / 2)) + m, w)));
  return fill([...Array<string>(top).fill(blank(w)), ...body], h, w);
}

function clipboard(text: string): boolean {
  const candidates: [string, string[]][] = [
    ["pbcopy", []],
    ["wl-copy", []],
    ["xclip", ["-selection", "clipboard"]],
    ["xsel", ["--clipboard", "--input"]],
  ];
  for (const [cmd, args] of candidates) {
    const result = spawnSync(cmd, args, { input: text });
    if (!result.error && result.status === 0) return true;
  }
  return false;
}

/** A whole value as text you can paste somewhere: JSON for collections. */
function wholeText(v: d.Value): string {
  const t = (b: Buffer) => d.printable(b);
  switch (v.kind) {
    case "string": return d.valueText(v.data);
    case "json": return v.text;
    case "hash": return JSON.stringify(Object.fromEntries(v.rows.map((r) => [t(r.field), t(r.value)])), null, 2);
    case "list": case "set": case "vectorset": return JSON.stringify(v.rows.map(t), null, 2);
    case "zset": return JSON.stringify(v.rows.map((r) => ({ member: t(r.member), score: Number(r.score) })), null, 2);
    case "stream": return JSON.stringify(v.rows.map((r) => ({ id: r.id, ...Object.fromEntries(r.fields.map(([f, x]) => [t(f), t(x)])) })), null, 2);
    case "timeseries": return JSON.stringify(v.rows, null, 2);
    default: return "";
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expire = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timed out")), ms);
  });
  return Promise.race([p, expire]).finally(() => clearTimeout(timer));
}

export class RedisApp {
  private screen = new Screen();
  private conn!: RedisConn;
  private mon: RedisConn | null = null;
  private sub: RedisConn | null = null;
  /** How Redis sees shellup's own connections, so its commands can be kept out of the feed. */
  private ownAddrs = new Set<string>();
  /** Fallback when a server can't say (before Redis 5): shellup's local ports. */
  private ownPorts = new Set<number>();
  private monId: number | null = null;
  /** The activity feed stays off until then after Redis queued more than shellup could read. */
  private monitorBusyUntil = 0;
  private started = false;
  private exiting = false;
  private connected = false;
  private eventsLive = false;
  private monitorLive = false;
  private startingEvents = false;
  private startingMonitor = false;
  /** notify-keyspace-events as it was before shellup changed it; null when untouched. */
  private notifyOriginal: string | null = null;
  /** The value shellup last set. On exit, a different value means someone else changed it since. */
  private notifySet: string | null = null;
  private flagsOk = false;
  private notifyNote = "";
  private db: number;

  private view: View = "keys";
  private focus: "list" | "value" = "list";
  private help = false;
  private detail: { title: string; text: string; top: number } | null = null;
  private input: { label: string; chars: string[]; pos: number; submit: (v: string) => void } | null = null;
  private confirm: { text: string; strong: boolean; typed: string; run: () => Promise<unknown> } | null = null;
  private toastMsg: { text: string; kind: "ok" | "err" | "info"; until: number } | null = null;

  private filter = "*";
  private filterRe = /^[\s\S]*$/;
  private ids: string[] = [];
  private idSet = new Set<string>();
  private labels = new Map<string, string>();
  private truncated = false;
  private scanning = false;
  private scanPromise: Promise<void> | null = null;
  private scanAgain = false;
  private scanLoud = false;
  /** Key events that arrive while a scan walks the keyspace; replayed onto its result. */
  private scanEvents: Map<string, "add" | "remove"> | null = null;
  private countMismatch = 0;
  private reselect = false;
  private pendingAdd = new Set<string>();
  private pendingRemove = new Set<string>();
  private rowsDirty = true;
  private expanded = new Set<string>();
  private collapsed = new Set<string>();
  private rows: Row[] = [];
  private cursor = 0;
  private listTop = 0;
  private listPage = 10;
  private meta = new Map<string, d.KeyMeta>();
  private metaPending = new Set<string>();
  private flashes = new Map<string, number>();
  private selected: string | null = null;
  private value: d.Value | null = null;
  private valueFor: string | null = null;
  private valueExtra = "";
  private valueToken = 0;
  private valueCursor = 0;
  private valueTop = 0;
  private valueLen = 0;
  private valuePage = 10;
  private valueDetail: (i: number) => string = () => "";
  /** Built once per value and width, not once per frame: pretty JSON and hex dumps of 500 rows add up. */
  private valueCache: { value: d.Value; width: number; tick: number; content: ValueContent } | null = null;
  private detailCache: { text: string; width: number; lines: string[] } | null = null;

  private activity: Entry[] = [];
  private actItems: Entry[] = [];
  private seq = 0;
  private paused: number | null = null;
  private activityFilter = "";
  /** The selected entry's seq, so trimming old entries never moves the selection. null follows the newest. */
  private actSel: number | null = null;
  private actTop = 0;
  private actPage = 10;

  private messages: Message[] = [];
  private channels: { name: string; subs: number }[] = [];
  private chanCursor = 0;
  private chanFilter: string | null = null;

  private info: d.Info = {};
  private hitAll: number | null = null;
  /** shellup's own key lookups: Redis counts them too, so they're subtracted from your apps' hit rate. */
  private own: d.Tally = { hits: 0, misses: 0 };
  private samples: { at: number; hits: number; misses: number; ownHits: number; ownMisses: number }[] = [];
  private appHit: { rate: number | null; hits: number; misses: number } = { rate: null, hits: 0, misses: 0 };
  /** Your apps' commands, counted from MONITOR (so shellup's own never appear). */
  private cmdCounts = new Map<string, number>();
  private cmdTotal = 0;
  private commandStats: { name: string; calls: number; usecPer: number }[] = [];
  private slowlog: d.SlowEntry[] = [];
  private clients: Record<string, string>[] = [];

  private tick = 0;
  private polling = false;
  private detailPage = 10;
  private timers: NodeJS.Timeout[] = [];
  private retryTimer: NodeJS.Timeout | null = null;
  private renderTimer: NodeJS.Timeout | null = null;
  private selectTimer: NodeJS.Timeout | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private flashTimer: NodeJS.Timeout | null = null;
  private toastTimer: NodeJS.Timeout | null = null;
  private quietScanTimer: NodeJS.Timeout | null = null;
  private done: () => void = () => undefined;

  constructor(private opts: AppOptions) {
    this.db = opts.target.db;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /** Connects first (so a connection error prints normally), then takes over the terminal until you quit. */
  async run(): Promise<void> {
    const finished = new Promise<void>((resolve) => (this.done = resolve));
    const stop = () => void this.quit();
    const crash = (err: unknown) => {
      this.screen.stop();
      console.error(err);
      void this.quit(1);
    };
    const restoreTerminal = () => this.screen.stop();
    // Installed before shellup changes anything on the server, so a Ctrl-C or a kill
    // during startup still puts notify-keyspace-events back.
    const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"];
    for (const sig of signals) process.on(sig, stop);
    process.on("uncaughtException", crash);
    process.on("unhandledRejection", crash);
    process.on("exit", restoreTerminal);
    try {
      await this.connectMain();
      if (!this.exiting) await this.startEvents(false);
      if (!this.exiting && this.opts.monitor) await this.startMonitor(false);
      if (!this.exiting) await this.poll(true);
      if (!this.exiting) {
        this.screen.start((k) => this.onKey(k), () => this.render());
        this.started = true;
        this.timers.push(setInterval(() => void this.poll(false), 1000));
        this.timers.push(setInterval(() => void this.checkMonitorBacklog(), 250));
        void this.rescan();
        this.render();
      }
      await finished;
    } finally {
      for (const sig of signals) process.off(sig, stop);
      process.off("uncaughtException", crash);
      process.off("unhandledRejection", crash);
      process.off("exit", restoreTerminal);
    }
  }

  private async quit(code = 0): Promise<void> {
    if (this.exiting) return;
    this.exiting = true;
    for (const t of this.timers) clearInterval(t);
    for (const t of [this.retryTimer, this.renderTimer, this.selectTimer, this.refreshTimer, this.flashTimer, this.toastTimer, this.quietScanTimer]) {
      if (t) clearTimeout(t);
    }
    this.screen.stop();
    await this.restoreNotify();
    this.conn?.close();
    this.mon?.close();
    this.sub?.close();
    if (code) process.exitCode = code;
    this.done();
  }

  /** Puts notify-keyspace-events back the way shellup found it, unless something else has changed it since. */
  private async restoreNotify(): Promise<void> {
    if (this.notifyOriginal === null) return;
    const original = this.notifyOriginal;
    const t = this.opts.target;
    let conn: RedisConn | null = null;
    try {
      conn = this.connected && !this.conn.closed ? this.conn : await withTimeout(RedisConn.connect(this.conf("shellup-redis-restore")), 2000);
      const now = d.str(d.asList(await withTimeout(conn.call("CONFIG", "GET", "notify-keyspace-events"), 2000))[1]);
      // Your app, or another shellup, changed it after shellup did: that newer value wins.
      if (this.notifySet !== null && now !== this.notifySet) {
        console.error(`notify-keyspace-events was changed while shellup was open, so it was left as "${now}".`);
        return;
      }
      await withTimeout(conn.call("CONFIG", "SET", "notify-keyspace-events", original), 2000);
    } catch (err) {
      console.error(
        `shellup couldn't restore notify-keyspace-events on ${t.address} (${err instanceof Error ? err.message : String(err)}).\n` +
          `Put it back with:  redis-cli -h ${t.host} -p ${t.port} CONFIG SET notify-keyspace-events "${original}"`,
      );
    } finally {
      if (conn && conn !== this.conn) conn.close();
    }
  }

  // ── Connections ──────────────────────────────────────────────────────────

  private conf(name: string) {
    const t = this.opts.target;
    return { host: t.host, port: t.port, tls: t.tls, username: t.username, password: t.password, db: this.db, name };
  }

  /** Records the address Redis sees a connection on (and returns its client id). */
  private async identify(conn: RedisConn): Promise<number | null> {
    const who = await d.whoAmI(conn).catch(() => ({ id: null, addr: null }));
    if (who.addr) this.ownAddrs.add(who.addr);
    else if (conn.localPort) this.ownPorts.add(conn.localPort);
    return who.id;
  }

  private isOwn(source: string): boolean {
    if (this.ownAddrs.has(source)) return true;
    const colon = source.lastIndexOf(":");
    return colon !== -1 && this.ownPorts.has(Number(source.slice(colon + 1)));
  }

  private async connectMain(): Promise<void> {
    const conn = await RedisConn.connect(this.conf("shellup-redis"));
    conn.onClose(() => {
      if (conn === this.conn) this.onDisconnect();
    });
    this.conn = conn;
    this.connected = true;
    await this.identify(conn);
  }

  /**
   * Key events power the live key list. They need notify-keyspace-events to
   * include E (event channels) and A (every kind of change); it's usually empty,
   * so shellup adds what's missing and restores the original on exit.
   */
  private async startEvents(quiet: boolean): Promise<void> {
    if (this.startingEvents || !this.connected) return;
    this.startingEvents = true;
    try {
      await this.ensureNotifyFlags();
      if (!this.sub) {
        const sub = await RedisConn.connect(this.conf("shellup-redis-events"));
        await this.identify(sub);
        sub.onClose(() => {
          if (this.sub === sub) {
            this.sub = null;
            this.eventsLive = false;
          }
        });
        sub.psubscribe(["*"], (channel, message) => this.onMessage(channel, message));
        this.sub = sub;
      }
    } catch (err) {
      if (!quiet) this.toast(`Live key events unavailable: ${err instanceof Error ? err.message : String(err)}`, "err");
    } finally {
      this.eventsLive = this.flagsOk && this.sub !== null;
      this.startingEvents = false;
    }
  }

  private async readNotify(): Promise<string> {
    return d.str(d.asList(await this.conn.call("CONFIG", "GET", "notify-keyspace-events"))[1]);
  }

  /**
   * Makes sure notify-keyspace-events has E (event channels) and A (every kind of
   * change). Run at start and every few seconds, because your app or another shellup
   * may change it. Returns true when it had to switch them back on.
   */
  private async ensureNotifyFlags(): Promise<boolean> {
    try {
      const current = await this.readNotify();
      const missing = [..."EA"].filter((c) => !current.includes(c));
      if (!missing.length) {
        this.flagsOk = true;
        return false;
      }
      if (this.opts.readOnly) {
        this.flagsOk = false;
        this.notifyNote = "key events off (read-only)";
        return false;
      }
      // What goes back on exit is whatever was there just before shellup's latest
      // change, so a value your app set in the meantime isn't thrown away.
      this.notifyOriginal = current;
      this.notifySet = null;
      await this.conn.call("CONFIG", "SET", "notify-keyspace-events", current + missing.join(""));
      this.notifySet = await this.readNotify();
      this.flagsOk = true;
      this.notifyNote = "";
      return true;
    } catch {
      this.flagsOk = false;
      this.notifyNote = "key events unavailable";
      return false;
    }
  }

  /** MONITOR streams every command the server runs: that's the Activity feed. */
  private async startMonitor(quiet: boolean): Promise<void> {
    if (this.startingMonitor || !this.connected || Date.now() < this.monitorBusyUntil) return;
    this.startingMonitor = true;
    try {
      const mon = await RedisConn.connect(this.conf("shellup-redis-monitor"));
      const id = await this.identify(mon);
      mon.onClose(() => {
        if (this.mon === mon) {
          this.mon = null;
          this.monitorLive = false;
        }
      });
      await mon.monitor((line) => this.onMonitor(line));
      if (this.exiting) return mon.close();
      this.mon = mon;
      this.monId = id;
      this.monitorLive = true;
    } catch (err) {
      this.monitorLive = false;
      if (!quiet) this.toast(`Activity feed unavailable: ${err instanceof Error ? err.message : String(err)}`, "err");
    } finally {
      this.startingMonitor = false;
    }
  }

  /**
   * MONITOR has no flow control: whatever shellup doesn't read piles up in Redis's own
   * memory, and under maxmemory that can evict your keys. Checked four times a second;
   * past a small limit the feed stops for 30 seconds and Redis frees the backlog.
   */
  private async checkMonitorBacklog(): Promise<void> {
    if (!this.monitorLive || this.monId === null || !this.connected || this.exiting) return;
    const line = d.str(await this.conn.call("CLIENT", "LIST", "ID", this.monId).catch(() => null));
    const backlog = Number(/\bomem=(\d+)/.exec(line)?.[1] ?? 0);
    const max = Number(this.info.memory?.maxmemory ?? 0);
    const limit = max > 0 ? Math.max(1 << 20, Math.min(32 << 20, max * 0.05)) : 32 << 20;
    if (backlog <= limit) return;
    const mon = this.mon;
    this.mon = null;
    this.monId = null;
    this.monitorLive = false;
    mon?.close();
    this.monitorBusyUntil = Date.now() + 30_000;
    this.toast(`Activity paused for 30s: Redis was holding ${d.formatBytes(backlog)} of commands shellup couldn't read fast enough`, "err");
  }

  private onDisconnect(): void {
    if (this.exiting) return;
    this.connected = false;
    this.eventsLive = false;
    this.monitorLive = false;
    this.mon?.close();
    this.sub?.close();
    this.mon = null;
    this.sub = null;
    this.monId = null;
    this.ownAddrs.clear();
    this.ownPorts.clear();
    this.schedule();
    const retry = async () => {
      if (this.exiting) return;
      try {
        await this.connectMain();
        await this.startEvents(true);
        if (this.opts.monitor) await this.startMonitor(true);
        this.toast("Reconnected", "ok");
        this.meta.clear();
        void this.rescan(true);
      } catch {
        this.retryTimer = setTimeout(() => void retry(), 1000);
      }
      this.schedule();
    };
    this.retryTimer = setTimeout(() => void retry(), 1000);
  }

  // ── Incoming ─────────────────────────────────────────────────────────────

  private onMonitor(line: string): void {
    const e = d.parseMonitorLine(line);
    // shellup's own SCAN/TYPE/INFO would drown out your app, so they're hidden.
    if (!e || this.isOwn(e.source)) return;
    const cmd = (e.args[0] ?? "").toUpperCase();
    if (!cmd) return;
    const key = d.keyOf(cmd, e.args);
    this.cmdCounts.set(cmd, (this.cmdCounts.get(cmd) ?? 0) + 1);
    this.cmdTotal++;
    this.pushEntry({ at: e.at, db: e.db, kind: "cmd", source: e.source, cmd, args: e.args.slice(1), key });
    // These change every key at once without sending a single key event.
    if (cmd === "FLUSHDB" || cmd === "FLUSHALL" || cmd === "SWAPDB") {
      this.meta.clear();
      return this.scheduleQuietRescan(200);
    }
    // Without key events, a write is the only hint the key list is out of date.
    if (!this.eventsLive && key && e.db === this.db && !READ.test(cmd)) this.scheduleQuietRescan(1000);
  }

  private onMessage(channel: Buffer, message: Buffer): void {
    const name = channel.toString("latin1");
    const m = /^__keyevent@(\d+)__:(.+)$/.exec(name);
    if (m) return this.onKeyEvent(Number(m[1]), m[2]!, message);
    if (name.startsWith("__keyspace@")) return;
    this.messages.push({ at: Date.now(), channel: d.printable(channel), text: d.printable(message) });
    if (this.messages.length > MESSAGE_LIMIT + 200) this.messages.splice(0, 200);
    if (this.view === "pubsub") this.schedule();
  }

  private onKeyEvent(db: number, event: string, keyBuf: Buffer): void {
    const id = d.toId(keyBuf);
    const label = d.printable(keyBuf);
    // MONITOR already shows the command behind every other event; expiry and
    // eviction happen inside Redis, so only key events can report them.
    if (event === "expired" || event === "evicted" || !this.monitorLive) {
      this.pushEntry({ at: Date.now(), db, kind: "event", source: "", cmd: event.toUpperCase(), args: [label], key: label });
    }
    if (db !== this.db || !this.filterRe.test(id)) return;
    if (GONE.has(event)) {
      this.pendingRemove.add(id);
      this.pendingAdd.delete(id);
    } else {
      this.pendingAdd.add(id);
      this.pendingRemove.delete(id);
    }
    this.scanEvents?.set(id, GONE.has(event) ? "remove" : "add");
    const known = this.meta.get(id);
    if (known) known.stale = true;
    this.flashes.set(id, Date.now() + FLASH_MS);
    if (id === this.selected) this.refreshValueSoon();
    this.schedule();
  }

  private pushEntry(e: Omit<Entry, "seq" | "got" | "search">): void {
    const args = e.args.map((a) => (a.length > 300 ? a.slice(0, 300) + "…" : a));
    this.activity.push({ ...e, args, seq: ++this.seq, got: Date.now(), search: `${e.cmd} ${args.join(" ")} ${e.source}`.toLowerCase() });
    if (this.activity.length > ACTIVITY_LIMIT + 500) {
      if (this.paused === null) this.activity.splice(0, 500);
      else {
        // While paused, what's on screen stays put; the oldest of what arrived since goes.
        const first = this.activity.findIndex((x) => x.seq > this.paused!);
        if (first !== -1) this.activity.splice(first, Math.min(500, this.activity.length - first - 1));
      }
    }
    if (this.view !== "server") this.schedule();
  }

  // ── Polling ──────────────────────────────────────────────────────────────

  private async poll(force: boolean): Promise<void> {
    if (!this.connected || this.polling || this.exiting) return;
    this.polling = true;
    try {
      this.tick++;
      const info = d.parseInfo(d.str(await this.conn.call("INFO")));
      this.info = info;
      const st = info.stats ?? {};
      const hits = Number(st.keyspace_hits ?? 0);
      const misses = Number(st.keyspace_misses ?? 0);
      this.hitAll = hits + misses ? hits / (hits + misses) : null;
      // Your apps' hit rate over the last minute: Redis's counters minus shellup's own lookups.
      const now = Date.now();
      this.samples.push({ at: now, hits, misses, ownHits: this.own.hits, ownMisses: this.own.misses });
      while (this.samples.length > 2 && this.samples[1]!.at <= now - 60_000) this.samples.shift();
      const first = this.samples[0]!;
      const h = Math.max(0, hits - first.hits - (this.own.hits - first.ownHits));
      const m = Math.max(0, misses - first.misses - (this.own.misses - first.ownMisses));
      this.appHit = { rate: h + m ? h / (h + m) : null, hits: h, misses: m };

      const extras = force || this.tick % 2 === 0;
      if (this.view === "server" && extras) {
        const [stats, slow, clients] = await this.conn.pipeline([["INFO", "commandstats"], ["SLOWLOG", "GET", 10], ["CLIENT", "LIST"]]);
        this.commandStats = d.commandStats(d.parseInfo(d.str(stats)));
        this.slowlog = d.parseSlowlog(slow);
        this.clients = d.parseClients(d.str(clients));
      }
      if (this.view === "pubsub" && extras) {
        const raw = d.asList(await this.conn.call("PUBSUB", "CHANNELS", "*")).map(d.asBuf).filter((b) => !b.toString("latin1").startsWith("__key"));
        const counts = raw.length ? d.asList(await this.conn.call("PUBSUB", "NUMSUB", ...raw)) : [];
        this.channels = raw
          .map((b, i) => ({ name: d.printable(b), subs: d.num(counts[i * 2 + 1]) }))
          .sort((a, b) => (a.name < b.name ? -1 : 1));
      }
      // Your app, or another shellup quitting, may have switched key events off again.
      if (this.tick % 3 === 0 && this.sub) {
        const reapplied = await this.ensureNotifyFlags();
        this.eventsLive = this.flagsOk && this.sub !== null;
        if (reapplied) void this.rescan(true); // events were missed while they were off
      }
      // A FLUSHDB, or events missed any other way, shows as a count that doesn't add up.
      if (this.filter === "*" && !this.truncated && !this.scanPromise) {
        this.applyPending();
        const count = d.keyspace(info).get(this.db)?.keys ?? 0;
        const off = Math.abs(count - this.ids.length) > Math.max(3, count * 0.001);
        this.countMismatch = off ? this.countMismatch + 1 : 0;
        if (this.countMismatch >= 2) {
          this.countMismatch = 0;
          void this.rescan(true);
        }
      }
      // Without key events the list can't update itself, so rescan every few seconds.
      if (!this.eventsLive && this.view === "keys" && this.tick % 3 === 0) void this.rescan(true);
      if (!this.eventsLive && this.selected && this.tick % 2 === 0) void this.loadValue(this.selected, true);
      if (this.opts.monitor && !this.mon && this.tick % 3 === 0) void this.startMonitor(true);
      if (!this.sub && this.tick % 3 === 0) void this.startEvents(true);
    } catch {
      /* the header shows the connection state */
    } finally {
      this.polling = false;
      this.schedule();
    }
  }

  // ── Keys ─────────────────────────────────────────────────────────────────

  private labelFor(id: string): string {
    let label = this.labels.get(id);
    if (label === undefined) {
      label = d.printable(d.idBuf(id));
      this.labels.set(id, label);
    }
    return label;
  }

  private sortIds(): void {
    this.ids.sort((a, b) => {
      const la = this.labelFor(a);
      const lb = this.labelFor(b);
      return la < lb ? -1 : la > lb ? 1 : 0;
    });
  }

  /**
   * Rescans the keyspace. A request that arrives while a scan is running (a new
   * filter, another database, r) restarts it rather than being dropped, so the list
   * never shows one filter's keys under another's title.
   */
  private rescan(quiet = false): Promise<void> {
    if (!this.connected) return Promise.resolve();
    if (!quiet) {
      this.scanning = true;
      this.scanLoud = true;
    }
    if (this.scanPromise) {
      this.scanAgain = true;
      this.schedule();
      return this.scanPromise;
    }
    this.scanPromise = this.runScans().finally(() => {
      this.scanPromise = null;
      this.scanning = false;
      this.scanLoud = false;
      this.schedule();
    });
    return this.scanPromise;
  }

  private async runScans(): Promise<void> {
    do {
      this.scanAgain = false;
      const filter = this.filter;
      const db = this.db;
      const stale = () => this.scanAgain || this.exiting || filter !== this.filter || db !== this.db;
      this.scanEvents = new Map();
      this.schedule();
      try {
        const found = await d.scanKeys(this.conn, filter, KEY_LIMIT, stale);
        if (!found || stale()) {
          if (!this.exiting) this.scanAgain = true;
          continue;
        }
        const ids = new Set(found.ids);
        // Keys that changed while the scan was walking: it may have seen them before or
        // after, so the event is the newer truth.
        for (const [id, op] of this.scanEvents) {
          if (op === "add") ids.add(id);
          else ids.delete(id);
        }
        this.idSet = ids;
        this.ids = [...ids];
        const keep = new Map<string, string>();
        for (const id of this.ids) keep.set(id, this.labelFor(id));
        if (this.selected) keep.set(this.selected, this.labelFor(this.selected));
        this.labels = keep;
        this.sortIds();
        this.truncated = found.truncated;
        this.pendingAdd.clear();
        this.pendingRemove.clear();
        this.rowsDirty = true;
        if (!this.selected) {
          this.rebuildRows();
          const row = this.rows[this.cursor];
          if (row?.kind === "key") this.select(row.id, true);
        }
      } catch (err) {
        if (this.scanLoud && !this.exiting) this.toastErr(err);
      } finally {
        this.scanEvents = null;
      }
    } while (this.scanAgain && !this.exiting);
  }

  private scheduleQuietRescan(delay: number): void {
    if (this.quietScanTimer) return;
    this.quietScanTimer = setTimeout(() => {
      this.quietScanTimer = null;
      void this.rescan(true);
    }, delay);
  }

  /** Folds key events into the sorted list in batches, once per frame rather than once per event. */
  private applyPending(): void {
    if (!this.pendingAdd.size && !this.pendingRemove.size) return;
    let removed = false;
    for (const id of this.pendingRemove) {
      if (this.idSet.delete(id)) removed = true;
      // Keys come and go all day on a cache; their labels shouldn't pile up.
      if (id !== this.selected) this.labels.delete(id);
    }
    if (removed) this.ids = this.ids.filter((id) => this.idSet.has(id));
    let added = false;
    for (const id of this.pendingAdd) {
      if (this.idSet.has(id)) continue;
      if (this.idSet.size >= KEY_LIMIT) {
        this.truncated = true;
        break;
      }
      this.idSet.add(id);
      this.ids.push(id);
      added = true;
    }
    if (added) this.sortIds();
    this.pendingAdd.clear();
    this.pendingRemove.clear();
    // An event on a key already listed changes nothing in the tree: don't rebuild it.
    if (removed || added) this.rowsDirty = true;
  }

  /** Keys as a tree of their ":"-separated prefixes. A prefix holding a single key isn't worth a level. */
  private rebuildRows(): void {
    const keep = this.rows[this.cursor];
    const auto = this.ids.length <= AUTO_EXPAND;
    const rows: Row[] = [];
    const walk = (prefix: string, ids: string[], depth: number) => {
      const groups = new Map<string, string[]>();
      const entries: { sort: string; group?: string; id?: string }[] = [];
      for (const id of ids) {
        const label = this.labelFor(id);
        const rest = label.slice(prefix.length);
        const cut = rest.indexOf(":");
        if (cut > 0 && cut < rest.length - 1) {
          const g = prefix + rest.slice(0, cut + 1);
          let members = groups.get(g);
          if (!members) {
            members = [];
            groups.set(g, members);
            entries.push({ sort: g, group: g });
          }
          members.push(id);
        } else entries.push({ sort: label, id });
      }
      const flat = entries.map((e) => {
        const members = e.group ? groups.get(e.group)! : null;
        return members && members.length === 1 ? { sort: this.labelFor(members[0]!), id: members[0]! } : e;
      });
      flat.sort((a, b) => (a.sort < b.sort ? -1 : a.sort > b.sort ? 1 : 0));
      for (const e of flat) {
        if (e.group) {
          const members = groups.get(e.group)!;
          const open = this.expanded.has(e.group) || (auto && !this.collapsed.has(e.group));
          rows.push({ kind: "group", id: e.group, label: e.group, text: e.group.slice(prefix.length), depth, count: members.length, open });
          if (open) walk(e.group, members, depth + 1);
        } else {
          const label = this.labelFor(e.id!);
          rows.push({ kind: "key", id: e.id!, label, text: label.slice(prefix.length) || label, depth, count: 0, open: false });
        }
      }
    };
    walk("", this.ids, 0);
    this.rows = rows;
    this.rowsDirty = false;
    if (keep) {
      const at = rows.findIndex((r) => r.kind === keep.kind && r.id === keep.id);
      if (at !== -1) this.cursor = at;
    }
    this.cursor = clamp(this.cursor, 0, Math.max(0, rows.length - 1));
  }

  private setOpen(prefix: string, open: boolean): void {
    if (open) {
      this.expanded.add(prefix);
      this.collapsed.delete(prefix);
    } else {
      this.expanded.delete(prefix);
      this.collapsed.add(prefix);
    }
    this.rowsDirty = true;
  }

  /** Opens every group on the way to a key and puts the cursor on it. */
  private reveal(id: string): void {
    this.applyPending();
    const label = this.labelFor(id);
    for (let i = label.indexOf(":"); i > 0 && i < label.length - 1; i = label.indexOf(":", i + 1)) {
      this.setOpen(label.slice(0, i + 1), true);
    }
    this.rebuildRows();
    const at = this.rows.findIndex((r) => r.kind === "key" && r.id === id);
    if (at !== -1) this.cursor = at;
  }

  private setFilter(input: string): Promise<void> {
    const v = input.trim();
    // Plain text means "contains"; anything with glob characters is used as typed.
    this.filter = !v ? "*" : /[*?[]/.test(v) ? v : `*${v}*`;
    this.filterRe = d.globToRegExp(this.filter);
    // The value pane follows the new list's first key, not a key the filter just hid.
    this.selected = null;
    this.cursor = 0;
    this.listTop = 0;
    this.expanded.clear();
    this.collapsed.clear();
    return this.rescan();
  }

  private async switchDb(n: number): Promise<void> {
    await this.conn.call("SELECT", n);
    this.db = n;
    this.selected = null;
    this.value = null;
    this.valueFor = null;
    this.meta.clear();
    this.expanded.clear();
    this.collapsed.clear();
    this.cursor = 0;
    this.listTop = 0;
    this.ids = [];
    this.idSet = new Set();
    this.rowsDirty = true;
    await this.rescan();
    this.toast(`Switched to db${n}`, "ok");
  }

  private ensureMeta(ids: string[]): void {
    const now = Date.now();
    const need = ids.filter((id) => {
      if (this.metaPending.has(id)) return false;
      const m = this.meta.get(id);
      return !m || (m.stale === true && now - m.at > 1000);
    });
    if (!need.length || !this.connected) return;
    for (const id of need) this.metaPending.add(id);
    d.fetchMeta(this.conn, need, this.own)
      .then((found) => {
        for (const [id, m] of found) this.meta.set(id, m);
      })
      .catch(() => {
        // A placeholder, so a failing fetch isn't retried on every frame.
        for (const id of need) this.meta.set(id, { type: "?", ttlMs: -1, at: Date.now(), bytes: null, size: null });
      })
      .finally(() => {
        for (const id of need) this.metaPending.delete(id);
        this.schedule();
      });
  }

  private select(id: string, now: boolean): void {
    if (this.selected === id && (this.valueFor === id || this.selectTimer)) return;
    this.selected = id;
    this.valueCursor = 0;
    this.valueTop = 0;
    if (this.selectTimer) clearTimeout(this.selectTimer);
    // Holding ↓ through a long list shouldn't fetch every key it passes.
    this.selectTimer = setTimeout(() => {
      this.selectTimer = null;
      void this.loadValue(id, false);
    }, now ? 0 : 120);
  }

  private async loadValue(id: string, keepScroll: boolean): Promise<void> {
    if (!this.connected) return;
    const token = ++this.valueToken;
    try {
      // OBJECT reads without touching the key, so idle time is read before the value fetch resets it.
      const [encoding, idle] = await this.conn.pipeline([["OBJECT", "ENCODING", d.idBuf(id)], ["OBJECT", "IDLETIME", d.idBuf(id)]]);
      d.tally(this.own, typeof idle === "number", 2);
      const value = await d.fetchValue(this.conn, id, d.VALUE_LIMIT, this.own);
      const meta = await d.fetchMeta(this.conn, [id], this.own);
      if (token !== this.valueToken) return; // a newer selection won
      this.value = value;
      this.valueFor = id;
      const found = meta.get(id);
      if (found) this.meta.set(id, found);
      const parts: string[] = [];
      if (typeof encoding === "string" || Buffer.isBuffer(encoding)) parts.push(`encoding ${d.str(encoding)}`);
      if (typeof idle === "number") parts.push(`idle ${d.formatDuration(idle * 1000)}`);
      this.valueExtra = parts.join(" · ");
      if (!keepScroll) {
        this.valueCursor = 0;
        this.valueTop = 0;
      }
    } catch (err) {
      if (token === this.valueToken) this.toastErr(err);
    }
    this.schedule();
  }

  private refreshValueSoon(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      if (this.selected) void this.loadValue(this.selected, true);
    }, 250);
  }

  // ── Keyboard ─────────────────────────────────────────────────────────────

  private onKey(k: Key): void {
    if (k === "ctrl-c") return void this.quit();
    if (this.confirm) return this.confirmKey(k);
    if (this.input) return this.inputKey(k);
    if (this.help) {
      this.help = false;
      return this.schedule();
    }
    if (this.detail) {
      this.detailKey(k);
      return this.schedule();
    }
    if (k === "ctrl-l") {
      this.screen.invalidate();
      return this.schedule();
    }
    if (k === "q") return void this.quit();
    if (k === "?") {
      this.help = true;
      return this.schedule();
    }
    const n = ["1", "2", "3", "4"].indexOf(k);
    if (n !== -1) {
      this.view = VIEWS[n]![0];
      this.focus = "list";
      void this.poll(true);
      return this.schedule();
    }
    if (this.view === "keys") this.keysKey(k);
    else if (this.view === "activity") this.activityKey(k);
    else if (this.view === "pubsub") this.pubsubKey(k);
    this.schedule();
  }

  private keysKey(k: Key): void {
    if (this.focus === "value") return this.valueKey(k);
    const row = this.rows[this.cursor];
    switch (k) {
      case "up": case "k": return this.moveCursor(-1);
      case "down": case "j": return this.moveCursor(1);
      case "pageup": return this.moveCursor(-this.listPage);
      case "pagedown": return this.moveCursor(this.listPage);
      case "home": case "g": return this.moveCursor(-this.rows.length);
      case "end": case "G": return this.moveCursor(this.rows.length);
      case "right": case "l": case "enter":
        if (!row) return;
        if (row.kind === "group") return this.setOpen(row.id, k === "enter" ? !row.open : true);
        this.select(row.id, true);
        this.focus = "value";
        return;
      case "left": case "h": {
        if (!row) return;
        if (row.kind === "group" && row.open) return this.setOpen(row.id, false);
        for (let i = this.cursor - 1; i >= 0; i--) {
          const r = this.rows[i]!;
          if (r.kind === "group" && r.depth === row.depth - 1) {
            this.cursor = i;
            return;
          }
        }
        return;
      }
      case "tab":
        if (this.selected) this.focus = "value";
        return;
      case "/": return this.ask("Filter keys (glob like user:* or plain text)", this.filter === "*" ? "" : this.filter, (v) => void this.setFilter(v));
      case "escape":
        if (this.filter !== "*") void this.setFilter("");
        return;
      case "r":
        this.meta.clear();
        void this.rescan();
        if (this.selected) void this.loadValue(this.selected, true);
        return;
      case "s": return this.ask("Switch to database", String(this.db), (v) => {
        const n = Number(v.trim());
        if (!v.trim() || n === this.db) return;
        if (!Number.isInteger(n) || n < 0) return this.toast(`"${v}" isn't a database number`, "err");
        this.act(() => this.switchDb(n));
      });
      case "d": return this.deleteRow(row);
      case "D": return this.deleteMatching();
      case "t": return this.askTtl();
      case "n": return this.askRename();
      case "e": return this.askEdit();
      case "c": return this.copy(false);
    }
  }

  private moveCursor(delta: number): void {
    if (!this.rows.length) return;
    this.cursor = clamp(this.cursor + delta, 0, this.rows.length - 1);
    const row = this.rows[this.cursor];
    if (row?.kind === "key") this.select(row.id, false);
  }

  private valueKey(k: Key): void {
    const last = Math.max(0, this.valueLen - 1);
    switch (k) {
      case "up": case "k": this.valueCursor = clamp(this.valueCursor - 1, 0, last); return;
      case "down": case "j": this.valueCursor = clamp(this.valueCursor + 1, 0, last); return;
      case "pageup": this.valueCursor = clamp(this.valueCursor - this.valuePage, 0, last); return;
      case "pagedown": this.valueCursor = clamp(this.valueCursor + this.valuePage, 0, last); return;
      case "home": case "g": this.valueCursor = 0; return;
      case "end": case "G": this.valueCursor = last; return;
      case "left": case "h": case "tab": case "escape": this.focus = "list"; return;
      case "enter": {
        const text = this.valueDetail(this.valueCursor);
        if (text) this.detail = { title: this.labelFor(this.selected!), text, top: 0 };
        return;
      }
      case "c": return this.copy(true);
      case "e": return this.askEdit();
      case "t": return this.askTtl();
      case "n": return this.askRename();
      case "d":
        if (this.selected) this.deleteRow({ kind: "key", id: this.selected, label: this.labelFor(this.selected), text: "", depth: 0, count: 0, open: false });
        return;
      case "r":
        if (this.selected) void this.loadValue(this.selected, true);
        return;
    }
  }

  private activityKey(k: Key): void {
    const items = this.actItems;
    const last = items.length - 1;
    const at = this.selIndex(items);
    const pick = (i: number) => {
      const e = items[clamp(i, 0, Math.max(0, last))];
      this.actSel = e ? e.seq : null;
    };
    switch (k) {
      case "up": case "k":
        if (items.length) pick((at ?? items.length) - 1);
        return;
      case "down": case "j":
        if (at === null) return;
        if (at + 1 >= last) this.actSel = null;
        else pick(at + 1);
        return;
      case "pageup":
        if (items.length) pick((at ?? items.length) - this.actPage);
        return;
      case "pagedown":
        if (at === null) return;
        if (at + this.actPage >= last) this.actSel = null;
        else pick(at + this.actPage);
        return;
      case "home": case "g": pick(0); return;
      case "end": case "G": this.actSel = null; return;
      case " ": this.paused = this.paused === null ? this.seq : null; return;
      case "/": return this.ask("Show only activity containing", this.activityFilter, (v) => {
        this.activityFilter = v.trim();
        this.actSel = null;
      });
      case "escape": this.activityFilter = ""; return;
      case "x":
        this.activity = [];
        this.actSel = null;
        return;
      case "enter": {
        const e = at !== null ? items[at] : items[last];
        if (e) this.jumpTo(e);
        return;
      }
    }
  }

  /** Where the selected entry is in `items`, or the next one still shown if it was trimmed or filtered out. */
  private selIndex(items: Entry[]): number | null {
    if (this.actSel === null || !items.length) return null;
    let lo = 0;
    let hi = items.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (items[mid]!.seq < this.actSel) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private pubsubKey(k: Key): void {
    switch (k) {
      case "up": case "k": this.chanCursor = Math.max(0, this.chanCursor - 1); return;
      case "down": case "j": this.chanCursor = Math.min(Math.max(0, this.channels.length - 1), this.chanCursor + 1); return;
      case "enter": {
        const ch = this.channels[this.chanCursor];
        if (ch) this.chanFilter = this.chanFilter === ch.name ? null : ch.name;
        return;
      }
      case "escape": this.chanFilter = null; return;
      case "x": this.messages = []; return;
      case "p": {
        if (!this.writable()) return;
        return this.ask("Publish on channel", this.channels[this.chanCursor]?.name ?? "", (channel) => {
          if (!channel.trim()) return;
          this.ask(`Message for ${clip(channel, 30)}`, "", (message) =>
            this.act(async () => {
              const n = await d.publish(this.conn, channel, message);
              const others = Math.max(0, n - (this.sub ? 1 : 0));
              this.toast(`Published to ${channel}: ${others} subscriber${others === 1 ? "" : "s"} besides shellup got it`, "ok");
            }),
          );
        });
      }
    }
  }

  private detailKey(k: Key): void {
    const det = this.detail!;
    switch (k) {
      case "up": case "k": det.top = Math.max(0, det.top - 1); return;
      case "down": case "j": det.top += 1; return;
      case "pageup": det.top = Math.max(0, det.top - this.detailPage); return;
      case "pagedown": case " ": det.top += this.detailPage; return;
      case "home": case "g": det.top = 0; return;
      case "end": case "G": det.top = Number.MAX_SAFE_INTEGER; return;
      case "c": this.toast(clipboard(det.text) ? "Copied" : "No clipboard tool found (pbcopy, wl-copy, xclip or xsel)", "info"); return;
      default: if (["escape", "q", "enter", "left"].includes(k)) this.detail = null;
    }
  }

  private jumpTo(e: Entry): void {
    if (!e.key) return this.toast("That command doesn't name a key", "info");
    const key = e.key;
    this.act(async () => {
      if (e.db !== this.db) await this.switchDb(e.db);
      const id = d.toId(Buffer.from(key, "utf8"));
      if (!this.filterRe.test(id)) await this.setFilter("");
      if (!this.idSet.has(id)) {
        const exists = d.num(await this.conn.call("EXISTS", d.idBuf(id))) === 1;
        d.tally(this.own, exists, 1);
        if (!exists) return this.toast(`${key} doesn't exist any more`, "info");
        this.pendingAdd.add(id);
      }
      this.view = "keys";
      this.focus = "list";
      this.reveal(id);
      this.select(id, true);
    });
  }

  // ── Actions ──────────────────────────────────────────────────────────────

  private writable(): boolean {
    if (!this.opts.readOnly) return true;
    this.toast("Read-only: started with --read-only", "err");
    return false;
  }

  private deleteRow(row: Row | undefined): void {
    if (!row || !this.writable()) return;
    if (row.kind === "key") {
      return this.confirmThen(`Delete ${clip(row.label, 60)}?`, false, async () => {
        const n = await d.deleteKeys(this.conn, [row.id]);
        this.pendingRemove.add(row.id);
        if (row.id === this.selected) this.reselect = true;
        this.toast(n ? `Deleted ${row.label}` : `${row.label} was already gone`, n ? "ok" : "info");
      });
    }
    // Exactly the keys shown under this group, so an active filter narrows what's
    // deleted. A key named exactly like the prefix ("user:") is its own row, not in it.
    const ids = this.ids.filter((id) => {
      const label = this.labelFor(id);
      return label.startsWith(row.id) && label !== row.id;
    });
    this.confirmThen(`Delete all ${fmt(ids.length)} keys under ${clip(row.label, 40)}?`, true, async () => {
      const n = await d.deleteKeys(this.conn, ids);
      for (const id of ids) this.pendingRemove.add(id);
      if (this.selected && ids.includes(this.selected)) this.reselect = true;
      this.toast(`Deleted ${fmt(n)} keys`, "ok");
    });
  }

  private deleteMatching(): void {
    if (!this.writable()) return;
    const what = this.filter === "*" ? `EVERY key in db${this.db}` : `every key matching ${this.filter}`;
    this.confirmThen(`Delete ${what} (${fmt(this.ids.length)}${this.truncated ? "+" : ""} keys)?`, true, async () => {
      const n = await d.deleteMatching(this.conn, this.filter);
      this.toast(`Deleted ${fmt(n)} keys`, "ok");
      this.selected = null;
      await this.rescan(true);
    });
  }

  private askTtl(): void {
    const id = this.selected;
    if (!id || !this.writable()) return;
    const label = this.labelFor(id);
    this.ask(`TTL for ${clip(label, 30)}: 90, 5m, 2h, 1d or none`, "", (v) => {
      if (!v.trim()) return;
      const seconds = d.parseDuration(v);
      if (seconds === undefined) return this.toast(`"${v}" isn't a duration. Try 90, 5m, 2h, 1d or none`, "err");
      this.act(async () => {
        const ok = await d.setTtl(this.conn, id, seconds);
        this.meta.delete(id);
        if (ok) this.toast(seconds === null ? `${label} no longer expires` : `${label} expires in ${d.formatDuration(seconds * 1000)}`, "ok");
        else this.toast(seconds === null ? `${label} had no TTL` : `${label} doesn't exist any more`, "info");
        await this.loadValue(id, true);
      });
    });
  }

  private askRename(): void {
    const id = this.selected;
    if (!id || !this.writable()) return;
    const label = this.labelFor(id);
    this.ask(`Rename ${clip(label, 30)} to`, label, (to) => {
      if (!to || to === label) return;
      this.act(async () => {
        if (!(await d.renameKey(this.conn, id, to))) return this.toast(`${to} already exists, so nothing was renamed`, "err");
        const next = d.toId(Buffer.from(to, "utf8"));
        this.pendingRemove.add(id);
        if (this.filterRe.test(next)) this.pendingAdd.add(next);
        this.reveal(next);
        this.select(next, true);
        this.toast(`Renamed to ${to}`, "ok");
      });
    });
  }

  private askEdit(): void {
    const id = this.selected;
    if (!id || !this.writable()) return;
    const v = this.value;
    if (!v || this.valueFor !== id || v.kind !== "string") return this.toast("Only string values can be edited here", "info");
    if (v.total > 4096 || !d.isText(v.data) || v.data.includes(0x0a)) {
      return this.toast("Too long or multi-line to edit on one line: use redis-cli", "info");
    }
    const label = this.labelFor(id);
    this.ask(`New value for ${clip(label, 30)}`, v.data.toString("utf8"), (next) =>
      this.act(async () => {
        await d.setString(this.conn, id, next);
        this.toast("Saved (TTL kept)", "ok");
        await this.loadValue(id, true);
      }),
    );
  }

  private copy(row: boolean): void {
    if (!this.value || this.valueFor !== this.selected) return;
    const text = row ? this.valueDetail(this.valueCursor) : wholeText(this.value);
    if (!text) return this.toast("Nothing to copy", "info");
    this.toast(clipboard(text) ? `Copied ${row ? "this entry" : "the value"}` : "No clipboard tool found (pbcopy, wl-copy, xclip or xsel)", "info");
  }

  private ask(label: string, initial: string, submit: (v: string) => void): void {
    this.input = { label, chars: [...initial], pos: [...initial].length, submit };
  }

  private confirmThen(text: string, strong: boolean, run: () => Promise<unknown>): void {
    this.confirm = { text, strong, typed: "", run };
  }

  private act(work: () => Promise<unknown>): void {
    work()
      .catch((err) => this.toastErr(err))
      .finally(() => this.schedule());
  }

  private inputKey(k: Key): void {
    const inp = this.input!;
    switch (k) {
      case "enter": {
        this.input = null;
        inp.submit(inp.chars.join(""));
        break;
      }
      case "escape": this.input = null; break;
      case "backspace":
        if (inp.pos > 0) {
          inp.chars.splice(inp.pos - 1, 1);
          inp.pos--;
        }
        break;
      case "delete": inp.chars.splice(inp.pos, 1); break;
      case "left": inp.pos = Math.max(0, inp.pos - 1); break;
      case "right": inp.pos = Math.min(inp.chars.length, inp.pos + 1); break;
      case "home": inp.pos = 0; break;
      case "end": inp.pos = inp.chars.length; break;
      case "ctrl-u": inp.chars = []; inp.pos = 0; break;
      default:
        if ([...k].length === 1) {
          inp.chars.splice(inp.pos, 0, k);
          inp.pos++;
        }
    }
    this.schedule();
  }

  private confirmKey(k: Key): void {
    const c = this.confirm!;
    if (k === "escape") {
      this.confirm = null;
      this.toast("Cancelled", "info");
    } else if (!c.strong) {
      this.confirm = null;
      if (k === "y" || k === "Y") this.act(c.run);
      else this.toast("Cancelled", "info");
    } else if (k === "enter") {
      this.confirm = null;
      if (c.typed.trim().toLowerCase() === "yes") this.act(c.run);
      else this.toast("Cancelled: type yes to confirm", "info");
    } else if (k === "backspace") c.typed = c.typed.slice(0, -1);
    else if ([...k].length === 1) c.typed += k;
    this.schedule();
  }

  private toast(text: string, kind: "ok" | "err" | "info"): void {
    this.toastMsg = { text, kind, until: Date.now() + 3500 };
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.schedule(), 3600);
    this.schedule();
  }

  private toastErr(err: unknown): void {
    this.toast(err instanceof Error ? err.message : String(err), "err");
  }

  // ── Drawing ──────────────────────────────────────────────────────────────

  private schedule(): void {
    if (this.renderTimer || !this.started || this.exiting) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null;
      this.render();
    }, 30);
  }

  private render(): void {
    if (!this.started || this.exiting) return;
    const W = Math.max(1, this.screen.cols - 1);
    const H = this.screen.rows;
    if (W < 60 || H < 16) {
      this.screen.draw([pc.yellow(cell(" Make the terminal at least 61×16 for shellup redis (q quits)", W))]);
      return;
    }
    this.applyPending();
    if (this.rowsDirty) this.rebuildRows();
    if (this.reselect) {
      // After you delete the selected key, the value pane follows the cursor to the next one.
      this.reselect = false;
      const row = this.rows[this.cursor];
      if (row?.kind === "key") this.select(row.id, true);
    }
    const bodyH = H - 3;
    const body =
      this.view === "keys" ? this.keysView(W, bodyH)
      : this.view === "activity" ? this.activityBox(W, bodyH, true)
      : this.view === "server" ? this.serverView(W, bodyH)
      : this.pubsubView(W, bodyH);
    let lines = [this.header(W), this.tabs(W), ...fill(body, bodyH, W), this.footer(W)];
    if (this.detail) lines = this.place(lines, this.detailPanel(W, H), W);
    if (this.help) lines = this.place(lines, this.helpPanel(W, H), W);
    this.screen.draw(lines);

    const now = Date.now();
    for (const [id, until] of this.flashes) if (until <= now) this.flashes.delete(id);
    if (this.flashes.size && !this.flashTimer) {
      this.flashTimer = setTimeout(() => {
        this.flashTimer = null;
        this.schedule();
      }, 300);
    }
  }

  /** An overlay panel, centred. The rows it covers are replaced whole. */
  private place(lines: string[], panel: string[], W: number): string[] {
    const pw = width(panel[0] ?? "");
    const left = Math.max(0, Math.floor((W - pw) / 2));
    const top = Math.max(0, Math.floor((lines.length - panel.length) / 2));
    const out = [...lines];
    panel.forEach((p, i) => {
      out[top + i] = blank(left) + p + blank(W - left - pw);
    });
    return out;
  }

  private header(W: number): string {
    const t = this.opts.target;
    const ks = d.keyspace(this.info).get(this.db);
    const mem = this.info.memory?.used_memory_human;
    const ops = this.info.stats?.instantaneous_ops_per_sec;
    const left: Seg[] = [[" shellup redis ", (s) => pc.bold(pc.inverse(pc.cyan(s)))], ["  " + t.address], [` db${this.db}`, pc.dim]];
    const add = (s: string) => left.push(["  ·  ", pc.dim], [s]);
    if (this.info.server?.redis_version) add(`v${this.info.server.redis_version}`);
    add(`${fmt(ks?.keys ?? 0)} key${ks?.keys === 1 ? "" : "s"}`);
    if (mem) add(mem);
    if (ops !== undefined) add(`${fmt(Number(ops))} ops/s`);
    if (this.appHit.rate !== null) add(`hit ${pct(this.appHit.rate)}`);
    const right: Seg[] = [];
    if (this.opts.readOnly) right.push([" READ-ONLY ", (s) => pc.inverse(pc.yellow(s))], [" "]);
    right.push(
      !this.connected ? ["● reconnecting… ", pc.red]
      : this.eventsLive || this.monitorLive ? ["● live ", pc.green]
      : ["● polling ", pc.yellow],
    );
    return bar(left, right, W);
  }

  private tabs(W: number): string {
    const segs: Seg[] = [[" "]];
    VIEWS.forEach(([v, label], i) => {
      segs.push([` ${i + 1} ${label} `, v === this.view ? (s) => pc.inverse(pc.bold(s)) : pc.dim], [" "]);
    });
    return bar(segs, this.notifyNote ? [[this.notifyNote + " ", pc.yellow]] : [], W);
  }

  private footer(W: number): string {
    if (this.input) {
      const { label, chars, pos } = this.input;
      const room = Math.max(10, W - width(label) - 20);
      const start = Math.max(0, pos - room);
      const before = oneLine(chars.slice(start, pos).join(""));
      const at = oneLine(chars[pos] ?? " ");
      const after = oneLine(chars.slice(pos + 1).join(""));
      return bar(
        [[` ${label}: `, (s) => pc.bold(pc.cyan(s))], [start ? "…" + before : before], [at, pc.inverse], [after]],
        [[" ⏎ ok  esc cancel ", pc.dim]],
        W,
      );
    }
    if (this.confirm) {
      const c = this.confirm;
      return bar([[` ${c.text}  `, (s) => pc.bold(pc.yellow(s))], [c.strong ? `type yes, then ⏎: ${c.typed}▏` : "y / n", pc.bold]], [[" esc cancel ", pc.dim]], W);
    }
    const t = this.toastMsg;
    if (t && t.until > Date.now()) return bar([[` ${t.text}`, t.kind === "err" ? pc.red : t.kind === "ok" ? pc.green : pc.cyan]], [], W);
    return bar(this.hints().map((h): Seg => [h, pc.dim]), [], W);
  }

  private hints(): string[] {
    if (this.detail) return [" ↑↓ scroll", "  c copy", "  esc close"];
    switch (this.view) {
      case "keys":
        return this.focus === "value"
          ? [" ↑↓ move", "  ⏎ whole entry", "  ← back", "  c copy", "  e edit", "  t ttl", "  n rename", "  d delete", "  ? help"]
          : [" ↑↓ move", "  → open", "  / filter", "  d delete", "  D delete matching", "  t ttl", "  n rename", "  s db", "  r refresh", "  ? help", "  q quit"];
      case "activity":
        return [" ↑↓ scroll", "  space pause", "  / filter", "  ⏎ go to key", "  x clear", "  End follow", "  q quit"];
      case "server":
        return [" refreshes every 2 seconds", "  1-4 switch view", "  ? help", "  q quit"];
      case "pubsub":
        return [" ↑↓ channel", "  ⏎ only this channel", "  p publish", "  x clear", "  q quit"];
    }
  }

  // Keys view

  private keysView(W: number, H: number): string[] {
    const strip = H >= 20 ? 8 : 0;
    const topH = H - strip;
    const listW = clamp(Math.floor(W * 0.42), 30, 72);
    const left = this.listBox(listW, topH);
    const right = this.valueBox(W - listW, topH);
    const out = left.map((l, i) => l + (right[i] ?? ""));
    if (strip) out.push(...this.activityBox(W, strip, false));
    return out;
  }

  private ttlText(m: d.KeyMeta): string | null {
    if (m.ttlMs < 0) return null;
    const left = m.ttlMs - (Date.now() - m.at);
    return left <= 0 ? "expiring" : d.formatDuration(left);
  }

  private listBox(w: number, h: number): string[] {
    const inner = w - 2;
    const bodyH = h - 2;
    this.listPage = Math.max(1, bodyH - 1);
    this.cursor = clamp(this.cursor, 0, Math.max(0, this.rows.length - 1));
    if (this.cursor < this.listTop) this.listTop = this.cursor;
    if (this.cursor >= this.listTop + bodyH) this.listTop = this.cursor - bodyH + 1;
    this.listTop = clamp(this.listTop, 0, Math.max(0, this.rows.length - bodyH));
    const visible = this.rows.slice(this.listTop, this.listTop + bodyH);
    this.ensureMeta(visible.filter((r) => r.kind === "key").map((r) => r.id));
    const now = Date.now();
    let body: string[];
    if (!this.rows.length) {
      body = centered(
        this.scanning ? ["Scanning…"]
        : this.filter === "*" ? [`db${this.db} is empty.`, "Keys appear here as your app writes them."]
        : [`No keys match ${this.filter}.`, "esc clears the filter."],
        inner, bodyH,
      );
    } else body = visible.map((row, i) => this.rowLine(row, inner, this.listTop + i === this.cursor, now));
    const title = this.filter === "*" ? "Keys" : `Keys · ${this.filter}`;
    const note = this.scanning ? "scanning…" : `${fmt(this.ids.length)}${this.truncated ? "+" : ""}`;
    return box(title, note, fill(body, bodyH, inner), w, h, this.focus === "list");
  }

  private rowLine(row: Row, inner: number, isCursor: boolean, now: number): string {
    const indent = "  ".repeat(row.depth);
    let plain: string;
    let styled: string;
    if (row.kind === "group") {
      const count = fmt(row.count);
      const name = cell(`${indent}${row.open ? "▾" : "▸"} ${oneLine(row.text)}`, inner - width(count) - 1);
      plain = `${name} ${count}`;
      styled = `${pc.bold(name)} ${pc.dim(count)}`;
    } else {
      const m = this.meta.get(row.id);
      const type = m ? TYPE_SHORT[m.type] ?? m.type : "";
      const ttl = m ? this.ttlText(m) ?? "" : "";
      const name = cell(`${indent}  ${oneLine(row.text)}`, inner - 16);
      const typeCell = cell(type, 7);
      const ttlCell = cell(ttl, 7, "right");
      plain = `${name} ${typeCell} ${ttlCell}`;
      const flash = (this.flashes.get(row.id) ?? 0) > now;
      styled = `${flash ? pc.bold(pc.yellow(name)) : name} ${(m && TYPE_COLOR[m.type]) ? TYPE_COLOR[m.type]!(typeCell) : typeCell} ${pc.dim(ttlCell)}`;
    }
    if (!isCursor) return styled;
    return this.focus === "list" ? pc.inverse(plain) : pc.bold(plain);
  }

  private metaNote(id: string): string {
    const m = this.meta.get(id);
    if (!m) return "";
    if (m.type === "none") return "gone";
    const parts = [TYPE_SHORT[m.type] ?? m.type];
    if (m.size !== null) parts.push(m.type === "string" ? d.formatBytes(m.size) : `${fmt(m.size)} ${UNIT[m.type] ?? "items"}`);
    const ttl = this.ttlText(m);
    parts.push(ttl === null ? "no expiry" : ttl === "expiring" ? "expiring" : `TTL ${ttl}`);
    if (m.bytes !== null) parts.push(`${d.formatBytes(m.bytes)} in memory`);
    return parts.join(" · ");
  }

  private valueBox(w: number, h: number): string[] {
    const inner = w - 2;
    const bodyH = h - 2;
    if (!this.selected) return box("Value", "", centered(["Pick a key on the left to see its value."], inner, bodyH), w, h, false);
    const label = this.labelFor(this.selected);
    const note = this.metaNote(this.selected);
    if (!this.value || this.valueFor !== this.selected) return box(label, note, centered(["Loading…"], inner, bodyH), w, h, this.focus === "value");
    const v = this.value;
    const tick = v.kind === "hash" && v.rows.some((r) => r.ttlMs !== null) ? Math.floor(Date.now() / 1000) : 0;
    let cached = this.valueCache;
    if (!cached || cached.value !== v || cached.width !== inner || cached.tick !== tick) {
      cached = { value: v, width: inner, tick, content: this.valueContent(inner) };
      this.valueCache = cached;
    }
    const c = cached.content;
    const extra = this.valueExtra ? 1 : 0;
    const room = Math.max(1, bodyH - (c.head ? 1 : 0) - (c.foot ? 1 : 0) - extra);
    this.valueLen = c.lines.length;
    this.valueDetail = c.detail;
    this.valuePage = Math.max(1, room - 1);
    this.valueCursor = clamp(this.valueCursor, 0, Math.max(0, c.lines.length - 1));
    if (this.valueCursor < this.valueTop) this.valueTop = this.valueCursor;
    if (this.valueCursor >= this.valueTop + room) this.valueTop = this.valueCursor - room + 1;
    this.valueTop = clamp(this.valueTop, 0, Math.max(0, c.lines.length - room));
    const body: string[] = [];
    if (this.valueExtra) body.push(pc.dim(cell(this.valueExtra, inner)));
    if (c.head) body.push(c.head);
    for (let i = this.valueTop; i < this.valueTop + room && i < c.lines.length; i++) {
      body.push(i === this.valueCursor && this.focus === "value" ? pc.inverse(c.lines[i]!) : c.lines[i]!);
    }
    const filled = fill(body, bodyH - (c.foot ? 1 : 0), inner);
    if (c.foot) filled.push(pc.dim(cell(c.foot, inner)));
    return box(label, note, filled, w, h, this.focus === "value");
  }

  private table(iw: number, headers: string[], rows: string[][], detail: (i: number) => string, align: ("left" | "right")[] = []): ValueContent {
    const n = headers.length;
    const widths = headers.map((h, c) => Math.max(width(h), ...rows.slice(0, 300).map((r) => width(oneLine(r[c] ?? "")))));
    const cap = Math.max(8, Math.floor(iw * 0.4));
    let used = 0;
    for (let c = 0; c < n - 1; c++) {
      widths[c] = Math.min(widths[c]!, cap);
      used += widths[c]! + 2;
    }
    widths[n - 1] = Math.max(4, iw - used);
    const line = (r: string[]) => cell(r.map((v, c) => cell(oneLine(v), widths[c]!, align[c] ?? "left")).join("  "), iw);
    return { head: pc.dim(line(headers)), lines: rows.map(line), detail };
  }

  private valueContent(iw: number): ValueContent {
    const v = this.value!;
    const p = d.preview;
    const more = (shown: number, total: number) => (total > shown ? `showing ${fmt(shown)} of ${fmt(total)}` : undefined);
    const text = (lines: string[], whole: string, foot?: string): ValueContent => ({
      lines: lines.map((l) => cell(oneLine(l), iw)),
      detail: () => whole,
      foot,
    });
    switch (v.kind) {
      case "missing":
        return text(["This key no longer exists: it was deleted or it expired."], "");
      case "other":
        return text([`A ${v.type} value. shellup can't show this type's contents yet;`, "its TTL, size and memory are in the title above."], "");
      case "string": {
        const full = d.valueText(v.data);
        const foot = v.total > v.data.length ? `showing the first ${d.formatBytes(v.data.length)} of ${d.formatBytes(v.total)}` : undefined;
        return text(full.split("\n"), full, foot);
      }
      case "json":
        return text(v.text.split("\n"), v.text);
      case "hash": {
        const withTtl = v.rows.some((r) => r.ttlMs !== null);
        const now = Date.now();
        const rows = v.rows.map((r) => {
          const cols = [p(r.field), p(r.value)];
          if (withTtl) cols.push(r.ttlMs === null ? "" : d.formatDuration(Math.max(0, r.ttlMs - (now - v.at))));
          return cols;
        });
        const detail = (i: number) => (v.rows[i] ? `${d.printable(v.rows[i]!.field)}\n\n${d.valueText(v.rows[i]!.value)}` : "");
        return { ...this.table(iw, ["field", "value", ...(withTtl ? ["ttl"] : [])], rows, detail), foot: more(v.rows.length, v.total) };
      }
      case "list":
        return {
          ...this.table(iw, ["#", "value"], v.rows.map((r, i) => [String(i), p(r)]), (i) => (v.rows[i] ? d.valueText(v.rows[i]!) : ""), ["right"]),
          foot: more(v.rows.length, v.total),
        };
      case "set":
        return { ...this.table(iw, ["member"], v.rows.map((r) => [p(r)]), (i) => (v.rows[i] ? d.valueText(v.rows[i]!) : "")), foot: more(v.rows.length, v.total) };
      case "zset":
        return {
          ...this.table(iw, ["score", "member"], v.rows.map((r) => [r.score, p(r.member)]), (i) => (v.rows[i] ? `${d.printable(v.rows[i]!.member)}\nscore ${v.rows[i]!.score}` : ""), ["right"]),
          foot: more(v.rows.length, v.total) ?? "lowest score first",
        };
      case "stream":
        return {
          ...this.table(
            iw,
            ["id", "fields"],
            v.rows.map((r) => [r.id, r.fields.map(([f, x]) => `${p(f, 200)}=${p(x, 200)}`).join("  ")]),
            (i) => {
              const r = v.rows[i];
              return r ? `${r.id}\n\n${r.fields.map(([f, x]) => `${d.printable(f)}: ${d.valueText(x)}`).join("\n")}` : "";
            },
          ),
          foot: `${more(v.rows.length, v.total) ?? "newest first"}${v.groups ? ` · ${v.groups} consumer group${v.groups === 1 ? "" : "s"}` : ""}`,
        };
      case "timeseries":
        return this.table(iw, ["time", "value"], v.rows.map((r) => [new Date(r.at).toISOString(), r.value]), (i) => (v.rows[i] ? `${new Date(v.rows[i]!.at).toISOString()}\n${v.rows[i]!.value}` : ""));
      case "vectorset":
        return {
          ...this.table(iw, ["element (random sample)"], v.rows.map((r) => [p(r)]), (i) => (v.rows[i] ? d.printable(v.rows[i]!) : "")),
          foot: `${fmt(v.total)} vectors${v.dim ? ` · ${v.dim} dimensions` : ""}`,
        };
    }
  }

  // Activity

  private visibleActivity(): Entry[] {
    const f = this.activityFilter.toLowerCase();
    const cutoff = this.paused;
    return this.activity.filter((e) => (cutoff === null || e.seq <= cutoff) && (!f || e.search.includes(f)));
  }

  private rate(): number {
    const since = Date.now() - 1000;
    let n = 0;
    for (let i = this.activity.length - 1; i >= 0 && this.activity[i]!.got > since; i--) n++;
    return n;
  }

  private entryLine(e: Entry, w: number): { plain: string; styled: string } {
    const head = `${clock(e.at)} ${`db${e.db}`.padEnd(4)} `;
    const colon = e.source.lastIndexOf(":");
    const who = cell(e.kind === "event" ? "" : colon === -1 ? e.source : e.source.slice(colon), 7);
    const cmd = cell(e.cmd, 10);
    const restW = Math.max(0, w - width(head) - 7 - 1 - 10 - 1);
    const rest = cell(e.args.map(quoteArg).join(" "), restW);
    const style = e.kind === "event" ? (e.cmd === "EVICTED" ? pc.red : pc.yellow) : commandStyle(e.cmd);
    const plain = cell(`${head}${who} ${cmd} ${rest}`, w);
    return { plain, styled: `${pc.dim(head + who)} ${style(cmd)} ${rest}` + blank(w - width(`${head}${who} ${cmd} ${rest}`)) };
  }

  private activityBox(w: number, h: number, full: boolean): string[] {
    const inner = w - 2;
    const bodyH = h - 2;
    const items = this.visibleActivity();
    this.actItems = items;
    this.actPage = Math.max(1, bodyH - 1);
    const busy = this.monitorBusyUntil > Date.now();
    let body: string[];
    if (!this.monitorLive && !this.eventsLive) {
      body = centered(
        busy ? ["Paused: Redis was queueing commands faster than shellup could read them.", "The feed comes back by itself shortly."]
        : this.opts.target.local && this.opts.monitor ? ["The activity feed isn't available: this server refused MONITOR."]
        : ["Activity uses MONITOR, which is off for servers on other machines.", "Pass --monitor to turn it on (it can slow a busy server)."],
        inner, bodyH,
      );
    } else if (!items.length) {
      body = centered([this.activityFilter ? `Nothing matches "${this.activityFilter}".` : "Waiting for commands: run your app and they show up here."], inner, bodyH);
    } else {
      let top: number;
      const cursor = full ? this.selIndex(items) : null;
      if (cursor !== null) {
        this.actSel = items[cursor]!.seq;
        if (cursor < this.actTop) this.actTop = cursor;
        if (cursor >= this.actTop + bodyH) this.actTop = cursor - bodyH + 1;
        top = clamp(this.actTop, 0, Math.max(0, items.length - bodyH));
        this.actTop = top;
      } else top = Math.max(0, items.length - bodyH);
      body = items.slice(top, top + bodyH).map((e, i) => {
        const l = this.entryLine(e, inner);
        return cursor === top + i ? pc.inverse(l.plain) : l.styled;
      });
    }
    const newer = this.paused === null ? 0 : this.activity.filter((e) => e.seq > this.paused!).length;
    const note = busy ? "paused: server too busy"
      : !this.monitorLive ? (this.eventsLive ? "key events only" : "off")
      : this.paused !== null ? `paused · ${fmt(newer)} new`
      : `${fmt(this.rate())}/s`;
    const title = full ? (this.activityFilter ? `Activity · "${this.activityFilter}"` : "Activity") : "Activity (live)";
    return box(title, note, fill(body, bodyH, inner), w, h, full);
  }

  // Server

  private simpleTable(headers: string[], rows: string[][], w: number, align: ("left" | "right")[] = []): string[] {
    const inner = Math.max(10, w - 2);
    const widths = headers.map((h, c) => Math.max(width(h), ...rows.map((r) => width(oneLine(r[c] ?? "")))));
    const flex = headers.length - 1;
    const fixed = widths.reduce((sum, x, c) => (c === flex ? sum : sum + x + 2), 0);
    widths[flex] = Math.max(4, Math.min(widths[flex]!, inner - fixed));
    const line = (r: string[]) => " " + r.map((v, c) => cell(oneLine(v), widths[c]!, align[c] ?? "left")).join("  ");
    const out = [pc.bold(cell(line(headers), w))];
    for (const r of rows) out.push(cell(line(r), w));
    if (!rows.length) out.push(pc.dim(cell("  nothing yet", w)));
    return out;
  }

  /** Your apps' commands while the activity feed is on (shellup's own excluded); otherwise Redis's all-client counts. */
  private topCommands(): [string[], string[][]] {
    if (this.monitorLive || this.cmdTotal) {
      const rows = [...this.cmdCounts].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, calls]) => [name, fmt(calls), pct(calls / this.cmdTotal)]);
      return [["Your apps' commands", "calls", "share"], rows];
    }
    return [["Commands, all clients", "calls", "avg"], this.commandStats.slice(0, 10).map((x) => [x.name, fmt(x.calls), `${x.usecPer.toFixed(1)} µs`])];
  }

  private notifyText(): string {
    const current = this.notifyOriginal !== null ? "shellup turned them on" : this.eventsLive ? "on" : "off";
    return this.notifyOriginal !== null
      ? `${current}; notify-keyspace-events goes back to "${this.notifyOriginal}" when you quit`
      : this.notifyNote || current;
  }

  private serverView(W: number, H: number): string[] {
    const i = this.info;
    const s = i.server ?? {};
    const m = i.memory ?? {};
    const st = i.stats ?? {};
    const c = i.clients ?? {};
    const ps = i.persistence ?? {};
    const n = (x?: string) => fmt(Number(x ?? 0));
    const row = (label: string, value: string) => bar([[" " + cell(label, 13), pc.dim], [value]], [], W);
    const lines = [
      row("Server", `redis ${s.redis_version ?? "?"} · ${s.redis_mode ?? "standalone"} · up ${d.formatDuration(Number(s.uptime_in_seconds ?? 0) * 1000)} · pid ${s.process_id ?? "?"}${s.config_file ? ` · ${s.config_file}` : " · no config file"}`),
      row("Memory", `${m.used_memory_human ?? "?"} used · peak ${m.used_memory_peak_human ?? "?"} · limit ${Number(m.maxmemory ?? 0) ? m.maxmemory_human : "none"} · eviction ${m.maxmemory_policy ?? "?"} · fragmentation ${m.mem_fragmentation_ratio ?? "?"}`),
      row("Traffic", `${n(st.instantaneous_ops_per_sec)} ops/s · ${n(st.total_commands_processed)} commands since start · ${n(c.connected_clients)} clients (${n(c.blocked_clients)} blocked)`),
      row("Cache", `${this.appHit.hits + this.appHit.misses ? `your apps hit ${pct(this.appHit.rate)} over the last minute (${fmt(this.appHit.hits)} hits, ${fmt(this.appHit.misses)} misses)` : "no lookups from your apps in the last minute"} · all clients since start ${pct(this.hitAll)} · ${n(st.expired_keys)} expired · ${n(st.evicted_keys)} evicted`),
      row("Keyspace", [...d.keyspace(i)].map(([db, k]) => `db${db} ${fmt(k.keys)} key${k.keys === 1 ? "" : "s"}${k.expires ? ` (${fmt(k.expires)} with TTL${k.avgTtl ? `, avg ${d.formatDuration(k.avgTtl)}` : ""})` : ""}`).join("   ") || "empty"),
      row("Persistence", `RDB ${ps.rdb_last_bgsave_status ?? "?"}, last save ${d.ago(Number(ps.rdb_last_save_time ?? 0))}, ${n(ps.rdb_changes_since_last_save)} changes since · AOF ${ps.aof_enabled === "1" ? "on" : "off"}`),
      row("Key events", this.notifyText()),
      blank(W),
    ];
    const [topHead, top] = this.topCommands();
    const slow = this.slowlog.slice(0, 10).map((x) => [`${(x.micros / 1000).toFixed(1)} ms`, clock(x.at).slice(0, 8), x.args.map(quoteArg).join(" ")]);
    if (W >= 110) {
      const half = Math.floor(W / 2);
      const t1 = this.simpleTable(topHead, top, half, ["left", "right", "right"]);
      const t2 = this.simpleTable(["Slow log", "at", "command"], slow, W - half, ["right", "left", "left"]);
      for (let k = 0; k < Math.max(t1.length, t2.length); k++) lines.push((t1[k] ?? blank(half)) + (t2[k] ?? blank(W - half)));
    } else {
      lines.push(...this.simpleTable(topHead, top, W, ["left", "right", "right"]), blank(W));
      lines.push(...this.simpleTable(["Slow log", "at", "command"], slow, W, ["right", "left", "left"]));
    }
    lines.push(blank(W));
    const clients = this.clients.map((x) => {
      const mine = this.isOwn(x.addr ?? "");
      return [(x.name || "–") + (mine ? " (shellup)" : ""), x.addr ?? "", x.db ?? "", x.cmd ?? "", d.formatDuration(Number(x.age ?? 0) * 1000), d.formatDuration(Number(x.idle ?? 0) * 1000)];
    });
    lines.push(...this.simpleTable(["Clients", "address", "db", "last command", "age", "idle"], clients, W, ["left", "left", "right", "left", "right", "right"]));
    return fill(lines, H, W);
  }

  // Pub/Sub

  private pubsubView(W: number, H: number): string[] {
    const leftW = clamp(Math.floor(W * 0.3), 28, 50);
    const left = this.channelsBox(leftW, H);
    const right = this.messagesBox(W - leftW, H);
    return left.map((l, i) => l + (right[i] ?? ""));
  }

  private channelsBox(w: number, h: number): string[] {
    const inner = w - 2;
    const bodyH = h - 2;
    this.chanCursor = clamp(this.chanCursor, 0, Math.max(0, this.channels.length - 1));
    const top = clamp(this.chanCursor - bodyH + 1, 0, Math.max(0, this.channels.length - bodyH));
    const body = this.channels.length
      ? this.channels.slice(top, top + bodyH).map((ch, i) => {
          const subs = `${ch.subs}`;
          const name = cell(`${this.chanFilter === ch.name ? "● " : "  "}${oneLine(ch.name)}`, inner - width(subs) - 1);
          const plain = `${name} ${subs}`;
          return top + i === this.chanCursor ? pc.inverse(plain) : `${name} ${pc.dim(subs)}`;
        })
      : centered(["No channel has a", "subscriber right now."], inner, bodyH);
    return box("Channels", "subscribers", fill(body, bodyH, inner), w, h, true);
  }

  private messagesBox(w: number, h: number): string[] {
    const inner = w - 2;
    const bodyH = h - 2;
    const items = this.chanFilter ? this.messages.filter((m) => m.channel === this.chanFilter) : this.messages;
    const body = items.length
      ? items.slice(-bodyH).map((m) => {
          const head = `${clock(m.at)} `;
          // The channel column gives way first on a narrow terminal, so the row still fits.
          const chW = clamp(inner - width(head) - 12, 4, 18);
          const channel = cell(oneLine(m.channel), chW);
          const text = cell(oneLine(m.text), Math.max(0, inner - width(head) - chW - 1));
          return `${pc.dim(head)}${pc.magenta(channel)} ${text}`;
        })
      : centered(["Messages published on any channel appear here.", "Press p to publish one."], inner, bodyH);
    return box(this.chanFilter ? `Messages · ${this.chanFilter}` : "Messages", fmt(items.length), fill(body, bodyH, inner), w, h, false);
  }

  // Overlays

  private helpPanel(W: number, H: number): string[] {
    const items: [string, string][] = [
      ["1 2 3 4", "Keys, Activity, Server, Pub/Sub"],
      ["↑ ↓  PgUp PgDn  g G", "move"],
      ["→ / ⏎    ←", "open a group or key / go back"],
      ["tab", "switch between the key list and the value"],
      ["/    esc", "filter keys (user:* or plain text) / clear it"],
      ["s", "switch database"],
      ["r", "rescan keys"],
      ["⏎ on a value row", "show that entry in full"],
      ["c", "copy the value (or the entry under the cursor)"],
      ["e", "edit a short string value"],
      ["t", "set a TTL: 90, 5m, 2h, 1d, none"],
      ["n", "rename the key"],
      ["d", "delete the key, or every key in a group"],
      ["D", "delete every key matching the filter"],
      ["space", "pause the activity feed"],
      ["x", "clear the activity or message list"],
      ["p", "publish a message (Pub/Sub)"],
      ["q  ctrl-c", "quit and restore what shellup changed"],
    ];
    const pw = Math.min(W - 4, 78);
    const inner = pw - 2;
    const body = items.map(([k, v]) => pc.cyan(cell(" " + k, 22)) + cell(v, inner - 22));
    body.push(blank(inner), pc.dim(cell(" Any key closes this.", inner)));
    return box("shellup redis", "", body, pw, Math.min(H - 2, body.length + 2), true);
  }

  private detailPanel(W: number, H: number): string[] {
    const det = this.detail!;
    const pw = W - 6;
    const ph = H - 4;
    const inner = pw - 2;
    const bodyH = ph - 2;
    this.detailPage = Math.max(1, bodyH - 1);
    let cached = this.detailCache;
    if (!cached || cached.text !== det.text || cached.width !== inner) {
      cached = { text: det.text, width: inner, lines: wrap(det.text, inner) };
      this.detailCache = cached;
    }
    const lines = cached.lines;
    det.top = clamp(det.top, 0, Math.max(0, lines.length - bodyH));
    const body = lines.slice(det.top, det.top + bodyH).map((l) => cell(l, inner));
    const where = lines.length > bodyH ? `${det.top + 1}-${Math.min(lines.length, det.top + bodyH)} of ${fmt(lines.length)} lines` : `${fmt(lines.length)} lines`;
    return box(det.title, where, fill(body, bodyH, inner), pw, ph, true);
  }
}

export type { Reply };
