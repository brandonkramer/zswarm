import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Small on-disk store shared by every zswarm process on the machine: the
 * delivery log, signal channels, and per-pane read cursors. Files are tiny and
 * written whole, so a torn read is a lost update at worst — never corruption.
 */

export type LogEntry = {
  at: number;
  op: string;
  session?: string | null;
  to?: string | null;
  from?: string | null;
  bytes?: number;
  ok: boolean;
  detail?: string | null;
};

export type SignalChannel = {
  count: number;
  at: number;
  last: string | null;
};

/**
 * Written by `bus --install` per Zellij session, after the plugin's permission
 * prompt has been answered. Its presence is what lets later runs try the fast
 * path without every cold `zswarm status` paying for a pipe that was never
 * going to answer.
 */
export type BusMarkerRecord = {
  plugin: string;
  configKey: string;
  installedAt: number;
};

type BusFile = {
  sessions?: Record<string, BusMarkerRecord>;
  plugin?: string;
  configKey?: string;
  installedAt?: number;
};

const LOG_FILE = "log.jsonl";
const SIGNALS_FILE = "signals.json";
const SIGNALS_LOCK = "signals.lock";
const CURSORS_FILE = "cursors.json";
const CURSORS_LOCK = "cursors.lock";
const BUS_FILE = "bus.json";
/** Keeps the log bounded without needing a rotation daemon. */
const LOG_TAIL_BYTES = 512 * 1024;
const LOCK_WAIT_MS = 5_000;
/** A live pid older than this is treated as a recycle of a crashed holder. */
const LOCK_STALE_MS = 30_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function defaultStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.ZSWARM_STATE_DIR?.trim();
  if (explicit) return explicit;
  return join(env.USERPROFILE || env.HOME || homedir(), ".zswarm");
}

export type StateStoreOptions = {
  dir?: string;
  env?: NodeJS.ProcessEnv;
};

export function createStateStore(options: StateStoreOptions = {}) {
  const env = options.env ?? process.env;
  const dir = options.dir ?? defaultStateDir(env);
  const logging = (env.ZSWARM_LOG ?? "").trim() !== "0";

  function ensureDir(): void {
    mkdirSync(dir, { recursive: true });
  }

  function readJson<T>(file: string, fallback: T): T {
    try {
      return JSON.parse(readFileSync(join(dir, file), "utf8")) as T;
    } catch {
      return fallback;
    }
  }

  /** Write through a temp file so readers never see a half-written object. */
  function writeJson(file: string, value: unknown): void {
    ensureDir();
    const target = join(dir, file);
    const tmp = `${target}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(value), "utf8");
    renameSync(tmp, target);
  }

  function appendLog(entry: LogEntry): void {
    if (!logging) return;
    try {
      ensureDir();
      appendFileSync(join(dir, LOG_FILE), `${JSON.stringify(entry)}\n`, "utf8");
    } catch {
      // The log is an aid, never a reason to fail an op.
    }
  }

  function readLog(): LogEntry[] {
    let raw: string;
    try {
      raw = readFileSync(join(dir, LOG_FILE), "utf8");
    } catch {
      return [];
    }
    if (raw.length > LOG_TAIL_BYTES) {
      raw = raw.slice(raw.length - LOG_TAIL_BYTES);
      raw = raw.slice(raw.indexOf("\n") + 1);
    }
    const out: LogEntry[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as LogEntry);
      } catch {
        // Skip a partially written trailing line.
      }
    }
    return out;
  }

  function pidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      // ESRCH: gone. EPERM: exists, just unsignalable — still a live holder.
      return (err as NodeJS.ErrnoException).code === "EPERM";
    }
  }

  /** Owner recorded in the lock file so a crash can be distinguished from a live holder. */
  function readLockOwner(lockPath: string): { pid: number; at: number } | null {
    try {
      const rec = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: unknown; at?: unknown };
      if (typeof rec.pid !== "number" || !Number.isInteger(rec.pid) || rec.pid <= 0) return null;
      const at = typeof rec.at === "number" ? rec.at : 0;
      return { pid: rec.pid, at };
    } catch {
      return null;
    }
  }

  /**
   * Dead pid → steal now. This process's own leftover (unlink failed, or a
   * non-reentrant re-entry) → steal now. A live pid whose `at` is older than
   * LOCK_STALE_MS is a recycled pid, not a holder still inside fn().
   * Empty leftover from older writers (wx with no owner bytes) → steal once
   * mtime is older than the wait, so an in-flight create is not yanked out
   * from under the holder.
   * Owner is read once: a second read can see a pid that appeared after an
   * empty snapshot and would steal a live lock.
   */
  function lockIsStale(lockPath: string): boolean {
    const owner = readLockOwner(lockPath);
    if (owner) {
      if (owner.pid === process.pid) return true;
      if (!pidAlive(owner.pid)) return true;
      return Date.now() - owner.at >= LOCK_STALE_MS;
    }
    try {
      return Date.now() - statSync(lockPath).mtimeMs >= LOCK_WAIT_MS;
    } catch {
      return false;
    }
  }

  function lockBusy(code: string | undefined): boolean {
    // Unix: O_EXCL on an existing file is EEXIST. Windows: a holder that still
    // has the handle open (or a delete-pending name) is EPERM / EACCES / EBUSY.
    return (
      code === "EEXIST" ||
      code === "EPERM" ||
      code === "EACCES" ||
      code === "EBUSY"
    );
  }

  function unlinkLock(lockPath: string): void {
    const until = Date.now() + 500;
    while (true) {
      try {
        rmSync(lockPath, { force: true });
        return;
      } catch (err) {
        if (!lockBusy((err as NodeJS.ErrnoException).code) || Date.now() >= until) {
          return;
        }
        sleepSync(10);
      }
    }
  }

  /**
   * Drop this process's lock file only. A close-then-retry unlink of whatever
   * sits at the path will delete a waiter that already recreated it with wx;
   * a third process then enters fn() and last-rename drops cursor keys
   * (macOS 80-child writeCursor wave under parallel `node --test` files).
   */
  function unlinkOwnedLock(lockPath: string): void {
    const until = Date.now() + 500;
    while (true) {
      if (readLockOwner(lockPath)?.pid !== process.pid) return;
      try {
        rmSync(lockPath, { force: true });
        return;
      } catch (err) {
        if (!lockBusy((err as NodeJS.ErrnoException).code) || Date.now() >= until) {
          return;
        }
        sleepSync(10);
      }
    }
  }

  function withFileLock<T>(lockName: string, fn: () => T): T {
    ensureDir();
    const lockPath = join(dir, lockName);
    const deadline = Date.now() + LOCK_WAIT_MS;
    while (true) {
      try {
        // One wx write, not open+write across a JS turn. Empty leftovers are
        // stolen after LOCK_WAIT_MS; 80 children plus sibling test files on
        // a few-core macOS runner can sit that long between openSync("wx")
        // and writing the pid, so a waiter unlinks the empty file, recreates
        // it, and two processes enter fn() — last-rename drops cursor keys.
        writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: Date.now() }), {
          encoding: "utf8",
          flag: "wx",
        });
        try {
          return fn();
        } finally {
          unlinkOwnedLock(lockPath);
        }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (!lockBusy(code)) throw err;
        if (lockIsStale(lockPath)) {
          unlinkLock(lockPath);
          continue;
        }
        if (Date.now() >= deadline) {
          throw new Error(`timed out waiting for ${lockName}`);
        }
        sleepSync(10);
      }
    }
  }

  function withSignalsLock<T>(fn: () => T): T {
    return withFileLock(SIGNALS_LOCK, fn);
  }

  function readSignals(): Record<string, SignalChannel> {
    return readJson<Record<string, SignalChannel>>(SIGNALS_FILE, {});
  }

  function postSignal(
    channel: string,
    payload: string | null,
    at: number,
  ): SignalChannel {
    return withSignalsLock(() => {
      const all = readSignals();
      const prev = all[channel];
      const next: SignalChannel = {
        count: (prev?.count ?? 0) + 1,
        at,
        last: payload,
      };
      all[channel] = next;
      writeJson(SIGNALS_FILE, all);
      return next;
    });
  }

  function clearSignal(channel: string | null): void {
    withSignalsLock(() => {
      if (channel === null) {
        writeJson(SIGNALS_FILE, {});
        return;
      }
      const all = readSignals();
      delete all[channel];
      writeJson(SIGNALS_FILE, all);
    });
  }

  function readCursor(key: string): string | null {
    const all = readJson<Record<string, string>>(CURSORS_FILE, {});
    return all[key] ?? null;
  }

  function writeCursor(key: string, text: string): void {
    withFileLock(CURSORS_LOCK, () => {
      const all = readJson<Record<string, string>>(CURSORS_FILE, {});
      all[key] = text;
      writeJson(CURSORS_FILE, all);
    });
  }

  function clearCursor(key: string): void {
    withFileLock(CURSORS_LOCK, () => {
      const all = readJson<Record<string, string>>(CURSORS_FILE, {});
      delete all[key];
      writeJson(CURSORS_FILE, all);
    });
  }

  function asMarker(value: unknown): BusMarkerRecord | null {
    if (!value || typeof value !== "object") return null;
    const rec = value as Record<string, unknown>;
    if (typeof rec.plugin !== "string" || !rec.plugin) return null;
    if (typeof rec.configKey !== "string" || !rec.configKey) return null;
    return {
      plugin: rec.plugin,
      configKey: rec.configKey,
      installedAt: typeof rec.installedAt === "number" ? rec.installedAt : 0,
    };
  }

  /**
   * Current `{ sessions: { <name>: marker } }` plus the pre-0.1.6 flat file
   * `{ plugin, configKey, installedAt }`, which any session may inherit until
   * the next write namespaces it.
   */
  function readBusFile(): {
    sessions: Record<string, BusMarkerRecord>;
    legacy: BusMarkerRecord | null;
  } {
    const raw = readJson<BusFile | null>(BUS_FILE, null);
    if (!raw || typeof raw !== "object") return { sessions: {}, legacy: null };
    const sessions: Record<string, BusMarkerRecord> = {};
    if (raw.sessions && typeof raw.sessions === "object") {
      for (const [name, marker] of Object.entries(raw.sessions)) {
        const parsed = asMarker(marker);
        if (parsed) sessions[name] = parsed;
      }
    }
    return { sessions, legacy: asMarker(raw) };
  }

  function readBus(session: string): BusMarkerRecord | null {
    if (!session) return null;
    const { sessions, legacy } = readBusFile();
    return sessions[session] ?? legacy;
  }

  function writeBus(session: string, marker: BusMarkerRecord): void {
    const { sessions } = readBusFile();
    sessions[session] = marker;
    writeJson(BUS_FILE, { sessions });
  }

  function clearBus(session?: string): void {
    if (!session) {
      try {
        rmSync(join(dir, BUS_FILE), { force: true });
      } catch {
        // Nothing to forget.
      }
      return;
    }
    const { sessions } = readBusFile();
    delete sessions[session];
    if (Object.keys(sessions).length === 0) {
      try {
        rmSync(join(dir, BUS_FILE), { force: true });
      } catch {
        // Nothing to forget.
      }
      return;
    }
    writeJson(BUS_FILE, { sessions });
  }

  /** Test helper: drop everything this store wrote. */
  function reset(): void {
    rmSync(dir, { recursive: true, force: true });
  }

  return {
    dir,
    logging,
    appendLog,
    readLog,
    readSignals,
    postSignal,
    clearSignal,
    readCursor,
    writeCursor,
    clearCursor,
    readBus,
    writeBus,
    clearBus,
    reset,
  };
}

export type StateStore = ReturnType<typeof createStateStore>;
