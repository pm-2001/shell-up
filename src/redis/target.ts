export interface Target {
  host: string;
  port: number;
  db: number;
  tls: boolean;
  username?: string;
  password?: string;
  /** host:port, for the header and error messages. */
  address: string;
  /** On this machine: MONITOR and switching on key events are safe to do by default. */
  local: boolean;
}

/** The address can't be used. The message is written for the user. */
export class TargetError extends Error {}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0"]);

/**
 * Accepts what people actually type: nothing (localhost:6379), a port, host:port,
 * host:port/db, or a redis:// or rediss:// URL. REDIS_URL fills in when nothing is
 * given, and REDISCLI_AUTH supplies a password the way it does for redis-cli.
 */
export function parseTarget(input: string | undefined, env: NodeJS.ProcessEnv = process.env): Target {
  const raw = (input ?? env.REDIS_URL ?? "").trim() || "127.0.0.1:6379";
  let host = "127.0.0.1";
  let port = 6379;
  let db = 0;
  let useTls = false;
  let username: string | undefined;
  let password: string | undefined;

  if (/^rediss?:\/\//i.test(raw)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new TargetError(`Can't read "${raw}" as a Redis URL.`);
    }
    useTls = url.protocol.toLowerCase() === "rediss:";
    host = url.hostname.replace(/^\[|\]$/g, "") || host;
    if (url.port) port = Number(url.port);
    if (url.username) username = decodeURIComponent(url.username);
    if (url.password) password = decodeURIComponent(url.password);
    const path = url.pathname.replace(/^\//, "");
    if (path) db = Number(path);
  } else if (/^\d+$/.test(raw)) {
    port = Number(raw);
  } else {
    const m = /^(\[[^\]]+\]|[^:/\s]*)(?::(\d+))?(?:\/(\d+))?$/.exec(raw);
    if (!m) throw new TargetError(`Can't read "${raw}". Try localhost:6379, localhost:6379/2 or redis://localhost:6379.`);
    if (m[1]) host = m[1].replace(/^\[|\]$/g, "");
    if (m[2]) port = Number(m[2]);
    if (m[3]) db = Number(m[3]);
  }

  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TargetError(`"${port}" isn't a valid port.`);
  if (!Number.isInteger(db) || db < 0) throw new TargetError(`"${db}" isn't a valid database number.`);
  if (password === undefined && env.REDISCLI_AUTH) password = env.REDISCLI_AUTH;
  // AUTH with a username needs a password too; a bare username means nothing to Redis.
  if (password === undefined) username = undefined;

  return {
    host,
    port,
    db,
    tls: useTls,
    username,
    password,
    address: `${host.includes(":") ? `[${host}]` : host}:${port}`,
    local: LOOPBACK.has(host.toLowerCase()),
  };
}
