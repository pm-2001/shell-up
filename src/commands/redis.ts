import pc from "picocolors";
import { parseTarget, TargetError, type Target } from "../redis/target.js";
import { RedisApp } from "../redis/app.js";

export interface RedisFlags {
  readOnly: boolean;
  /** undefined means "decide from the address". */
  monitor: boolean | undefined;
}

export async function redis(targetArg: string | undefined, flags: RedisFlags): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(`\n  ${pc.red("✖")} shellup redis is a live, full-screen view: run it in an interactive terminal.\n`);
    process.exitCode = 1;
    return;
  }

  let target: Target;
  try {
    target = parseTarget(targetArg);
  } catch (err) {
    if (!(err instanceof TargetError)) throw err;
    console.error(`\n  ${pc.red("✖")} ${err.message}\n`);
    process.exitCode = 2;
    return;
  }

  // MONITOR slows a busy server, so it's on by default only for a Redis on this machine.
  const monitor = flags.monitor ?? target.local;
  const app = new RedisApp({ target, readOnly: flags.readOnly, monitor });
  try {
    await app.run();
  } catch (err) {
    console.error(`\n  ${pc.red("✖")} ${explain(err, target)}\n`);
    process.exitCode = 1;
  }
  // Sockets, stdin and timers are all closed by now. Exiting explicitly means a
  // stray handle can never leave the terminal waiting after you quit.
  process.exit(Number(process.exitCode ?? 0));
}

function explain(err: unknown, t: Target): string {
  const code = (err as NodeJS.ErrnoException).code;
  const msg = err instanceof Error ? err.message : String(err);
  if (code === "ECONNREFUSED") {
    return `Nothing is listening on ${t.address}.\n    Start Redis (redis-server, or brew services start redis), or point shellup at yours: shellup redis localhost:6380`;
  }
  if (code === "ETIMEDOUT") return `${t.address} didn't answer within 3 seconds.`;
  if (code === "ENOTFOUND") return `Can't find a host called ${t.host}.`;
  if (/NOAUTH/i.test(msg)) return `${t.address} needs a password: shellup redis redis://:PASSWORD@${t.address}  (or set REDISCLI_AUTH)`;
  if (/WRONGPASS|invalid password|invalid username-password/i.test(msg)) return `Redis on ${t.address} rejected that username or password.`;
  if (/DB index is out of range/i.test(msg)) return `${t.address} has no database ${t.db}.`;
  return `Couldn't use Redis on ${t.address}: ${msg}`;
}
