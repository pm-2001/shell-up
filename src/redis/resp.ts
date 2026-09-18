import net from "node:net";
import tls from "node:tls";

/** An error reply from Redis. Kept as a value so a pipeline can report one failure per command. */
export class RedisError extends Error {}

export type Reply = null | number | string | Buffer | RedisError | Reply[];
export type Arg = string | number | Buffer;

export interface ConnectOptions {
  host: string;
  port: number;
  tls: boolean;
  username?: string;
  password?: string;
  db: number;
  /** Shows in CLIENT LIST, so anyone looking can tell shellup's connections apart. */
  name: string;
  timeoutMs?: number;
}

const CRLF = Buffer.from("\r\n");

function encode(args: Arg[]): Buffer {
  const parts: Buffer[] = [Buffer.from(`*${args.length}\r\n`)];
  for (const arg of args) {
    const bytes = Buffer.isBuffer(arg) ? arg : Buffer.from(String(arg));
    parts.push(Buffer.from(`$${bytes.length}\r\n`), bytes, CRLF);
  }
  return Buffer.concat(parts);
}

/** Parses one RESP2 value at `pos`. Undefined means the buffer doesn't hold all of it yet. */
function parseAt(buf: Buffer, pos: number): [Reply, number] | undefined {
  if (pos >= buf.length) return undefined;
  const end = buf.indexOf(CRLF, pos);
  if (end === -1) return undefined;
  const type = buf[pos];
  const line = buf.toString("utf8", pos + 1, end);
  const next = end + 2;
  switch (type) {
    case 0x2b: return [line, next]; // +simple string
    case 0x2d: return [new RedisError(line), next]; // -error
    case 0x3a: return [Number(line), next]; // :integer
    case 0x24: { // $bulk string: binary-safe, so kept as a Buffer
      const len = Number(line);
      if (len < 0) return [null, next];
      if (buf.length < next + len + 2) return undefined;
      return [buf.subarray(next, next + len), next + len + 2];
    }
    case 0x2a: { // *array
      const count = Number(line);
      if (count < 0) return [null, next];
      const items: Reply[] = [];
      let at = next;
      for (let i = 0; i < count; i++) {
        const item = parseAt(buf, at);
        if (!item) return undefined;
        items.push(item[0]);
        at = item[1];
      }
      return [items, at];
    }
    default:
      throw new Error(`unexpected RESP type byte 0x${(type ?? 0).toString(16)}`);
  }
}

class Parser {
  private buf: Buffer = Buffer.alloc(0);
  private pos = 0;

  push(chunk: Buffer): void {
    this.buf = this.pos < this.buf.length ? Buffer.concat([this.buf.subarray(this.pos), chunk]) : chunk;
    this.pos = 0;
  }

  next(): { value: Reply } | undefined {
    const result = parseAt(this.buf, this.pos);
    if (!result) return undefined;
    this.pos = result[1];
    return { value: result[0] };
  }
}

interface Waiter {
  resolve: (reply: Reply) => void;
  reject: (err: Error) => void;
  /** Resolve error replies too, instead of rejecting: pipelines report errors per command. */
  raw: boolean;
}

/**
 * A deliberately small RESP2 client: enough for a local-Redis browser (commands,
 * pipelines, MONITOR, PSUBSCRIBE), with no dependency for users who never touch it.
 */
export class RedisConn {
  private parser = new Parser();
  private waiters: Waiter[] = [];
  private push: ((reply: Reply) => void) | null = null;
  private closeHandlers: ((err: Error) => void)[] = [];
  closed = false;

  private constructor(private socket: net.Socket) {
    socket.on("data", (chunk: Buffer) => this.onData(chunk));
    socket.on("error", (err) => this.fail(err));
    socket.on("close", () => this.fail(new Error("connection closed")));
  }

  /** The port the server sees this connection on. MONITOR lines carry it, which lets shellup hide its own commands. */
  get localPort(): number | undefined {
    return this.socket.localPort;
  }

  static connect(o: ConnectOptions): Promise<RedisConn> {
    return new Promise((resolve, reject) => {
      const socket = o.tls
        ? tls.connect({ host: o.host, port: o.port, servername: net.isIP(o.host) ? undefined : o.host })
        : net.connect({ host: o.host, port: o.port });
      const onError = (err: Error) => {
        clearTimeout(timer);
        reject(err);
      };
      const timer = setTimeout(() => {
        socket.destroy();
        reject(Object.assign(new Error(`timed out connecting to ${o.host}:${o.port}`), { code: "ETIMEDOUT" }));
      }, o.timeoutMs ?? 3000);
      socket.once("error", onError);
      socket.once(o.tls ? "secureConnect" : "connect", () => {
        clearTimeout(timer);
        socket.off("error", onError);
        socket.setNoDelay(true);
        const conn = new RedisConn(socket);
        (async () => {
          if (o.password !== undefined) {
            await conn.call(...(o.username ? ["AUTH", o.username, o.password] : ["AUTH", o.password]));
          }
          // PING before anything whose errors are ignored: on a server that wants a
          // password it fails with NOAUTH, instead of leaving an empty, silent screen.
          await conn.call("PING");
          if (o.db) await conn.call("SELECT", o.db);
          await conn.call("CLIENT", "SETNAME", o.name).catch(() => undefined);
          return conn;
        })().then(resolve, (err) => {
          conn.close();
          reject(err);
        });
      });
    });
  }

  call(...args: Arg[]): Promise<Reply> {
    return this.send([args], false).then((replies) => replies[0] ?? null);
  }

  /** Sends every command in one write. Each reply comes back as a value, error replies included. */
  pipeline(commands: Arg[][]): Promise<Reply[]> {
    if (!commands.length) return Promise.resolve([]);
    return this.send(commands, true);
  }

  private send(commands: Arg[][], raw: boolean): Promise<Reply[]> {
    if (this.closed) return Promise.reject(new Error("connection closed"));
    const replies = commands.map(
      () => new Promise<Reply>((resolve, reject) => this.waiters.push({ resolve, reject, raw })),
    );
    this.socket.write(Buffer.concat(commands.map(encode)));
    return Promise.all(replies);
  }

  /** Every command the server runs, as MONITOR's text lines, until this connection closes. */
  async monitor(onLine: (line: string) => void): Promise<void> {
    this.push = (reply) => {
      if (typeof reply === "string") onLine(reply);
    };
    await this.call("MONITOR");
  }

  /** Subscribes to channel patterns. Messages arrive through `onMessage`. */
  psubscribe(patterns: string[], onMessage: (channel: Buffer, message: Buffer) => void): void {
    this.push = (reply) => {
      if (!Array.isArray(reply) || reply.length < 4) return;
      const kind = reply[0];
      if (Buffer.isBuffer(kind) && kind.toString() === "pmessage") {
        const channel = reply[2];
        const message = reply[3];
        if (Buffer.isBuffer(channel) && Buffer.isBuffer(message)) onMessage(channel, message);
      }
    };
    this.socket.write(encode(["PSUBSCRIBE", ...patterns]));
  }

  onClose(handler: (err: Error) => void): void {
    this.closeHandlers.push(handler);
  }

  /** Closes on purpose: close handlers don't fire, so nothing treats this as a lost connection. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter.reject(new Error("connection closed"));
    this.socket.destroy();
  }

  private onData(chunk: Buffer): void {
    try {
      this.parser.push(chunk);
      for (let next = this.parser.next(); next; next = this.parser.next()) {
        const reply = next.value;
        const waiter = this.waiters.shift();
        if (waiter) {
          if (reply instanceof RedisError && !waiter.raw) waiter.reject(reply);
          else waiter.resolve(reply);
        } else if (this.push) {
          this.push(reply);
        }
      }
    } catch (err) {
      this.fail(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private fail(err: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter.reject(err);
    this.socket.destroy();
    for (const handler of this.closeHandlers) handler(err);
  }
}
