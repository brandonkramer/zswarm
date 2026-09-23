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
/** Bound for waiting on a *live* lock holder before failing. */
const LOCK_WAIT_MS = 5_000;
/**
 * Fresh empty/malformed lock files this young are treated as an in-flight
 * exclusive create (wait), not as abandoned debris (refuse).
 */
const LOCK_PENDING_MS = LOCK_WAIT_MS;

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

  /**
   * Cursor/signal locks: exclusive create (`wx`) + owner stamp; release by
   * generation-matched unlink of the stamp this process published.
   *
   * Foreign / abandoned / empty-old lock files are NOT auto-reclaimed.
   * Portable check-then-rename/unlink reclaim can move a live holder's shared
   * name aside and admit another writer into that critical section (demonstrated
   * with real cooperating writeCursor processes). Prefer bounded fail-closed
   * refusal over unsafe automatic recovery.
   *
   * Self-pid leftovers (same process, prior unlink failed) may be removed when
   * the on-disk generation still matches — this process is not inside `fn()`.
   *
   * Operator recovery: if acquisition refuses an abandoned lock, confirm the
   * recorded pid is gone and no writer holds the file, then remove the lock
   * path manually and retry.
   */
  function unlinkIfMatchingOwner(
    lockPath: string,
    expected: { pid: number; at: number },
  ): boolean {
    const until = Date.now() + 500;
    while (true) {
      const current = readLockOwner(lockPath);
      if (
        !current ||
        current.pid !== expected.pid ||
        current.at !== expected.at
      ) {
        return false;
      }
      try {
        rmSync(lockPath, { force: true });
        return true;
      } catch (err) {
        if (!lockBusy((err as NodeJS.ErrnoException).code) || Date.now() >= until) {
          return false;
        }
        sleepSync(10);
      }
    }
  }

  /** Only this process may clear its own leftover generation. */
  function tryReclaimSelfLock(lockPath: string): boolean {
    const owner = readLockOwner(lockPath);
    if (!owner || owner.pid !== process.pid) return false;
    return unlinkIfMatchingOwner(lockPath, owner);
  }

  function abandonedLockError(lockName: string, lockPath: string): Error {
    const owner = readLockOwner(lockPath);
    if (owner) {
      const liveness = pidAlive(owner.pid) ? "live-or-unsignalable" : "dead-or-abandoned";
      return new Error(
        `refusing automatic reclaim of ${lockName} (${liveness} owner pid=${owner.pid} at=${owner.at}); ` +
          `remove ${lockPath} only after confirming that process is gone and no writer holds the file, then retry`,
      );
    }
    return new Error(
      `refusing automatic reclaim of ${lockName} (empty or malformed lock without a safe owner record); ` +
        `remove ${lockPath} only when no writer is using it, then retry`,
    );
  }

  /**
   * Classify a blocking lock file. `wait` = live holder or fresh in-flight
   * create. `refuse` = abandoned foreign/empty debris — fail closed now.
   * `self` = reclaimable same-pid leftover.
   */
  function classifyBlockingLock(
    lockPath: string,
  ): "self" | "wait" | "refuse" {
    const owner = readLockOwner(lockPath);
    if (owner) {
      if (owner.pid === process.pid) return "self";
      // Foreign owner: never auto-reclaim, whether the pid looks dead or live.
      // A dead-looking pid is still refuse (not steal): observation is not a
      // delete permit. Live holders are waited out until LOCK_WAIT_MS.
      if (pidAlive(owner.pid)) return "wait";
      return "refuse";
    }
    try {
      if (Date.now() - statSync(lockPath).mtimeMs < LOCK_PENDING_MS) return "wait";
    } catch {
      return "wait";
    }
    return "refuse";
  }

  /**
   * Drop this process's lock only when the generation we published is still at
   * the well-known path. Under fail-closed foreign reclaim, generations are not
   * stolen while we hold the critical section, so a matching unlink cannot
   * remove a successor published by another cooperating writer.
   */
  function unlinkOwnedLock(
    lockPath: string,
    stamp: { pid: number; at: number },
  ): void {
    unlinkIfMatchingOwner(lockPath, stamp);
  }

  function withFileLock<T>(lockName: string, fn: () => T): T {
    ensureDir();
    const lockPath = join(dir, lockName);
    const deadline = Date.now() + LOCK_WAIT_MS;
    while (true) {
      const stamp = { pid: process.pid, at: Date.now() };
      try {
        // Exclusive create (`wx`) plus a write of the owner record. That is
        // not one atomic publish of populated bytes — create and write still
        // have an interval. The UTF-8 fast path keeps that interval in one
        // native writeFileSync rather than two JS turns (openSync then write).
        // Abandoned foreign/empty locks are refused (not renamed or unlinked).
        writeFileSync(lockPath, JSON.stringify(stamp), {
          encoding: "utf8",
          flag: "wx",
        });
        try {
          return fn();
        } finally {
          unlinkOwnedLock(lockPath, stamp);
        }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (!lockBusy(code)) throw err;
        if (tryReclaimSelfLock(lockPath)) {
          continue;
        }
        const kind = classifyBlockingLock(lockPath);
        if (kind === "refuse") {
          throw abandonedLockError(lockName, lockPath);
        }
        if (Date.now() >= deadline) {
          throw kind === "wait"
            ? new Error(`timed out waiting for ${lockName}`)
            : abandonedLockError(lockName, lockPath);
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
