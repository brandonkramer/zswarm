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
   *
   * Ownership transition is rename-serialized: a cooperating reclaim/release
   * never `rmSync`s the well-known lock path. It renames that path to a private
   * tomb, then inspects the tomb. Only the rename winner can clear a given
   * on-disk generation; a successor published at the well-known path after that
   * rename is a different inode and is never deleted by the loser. A tomb whose
   * generation does not match the observation is restored (or left in place on
   * EEXIST) — fail closed, never destroy a possibly-live successor to keep
   * opportunistic recovery.
   */
  function ownerObservationIsStale(owner: { pid: number; at: number }): boolean {
    if (owner.pid === process.pid) return true;
    if (!pidAlive(owner.pid)) return true;
    return Date.now() - owner.at >= LOCK_STALE_MS;
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

  /** Private tomb path next to the well-known lock (same directory / volume). */
  function lockTombPath(
    lockPath: string,
    kind: "owner" | "empty",
    expected?: { pid: number; at: number },
  ): string {
    const tag =
      kind === "owner" && expected
        ? `${expected.pid}.${expected.at}`
        : "empty";
    return `${lockPath}.tomb.${process.pid}.${tag}.${process.hrtime.bigint()}`;
  }

  /**
   * Move the well-known lock to a private tomb. Only the rename winner owns
   * that inode thereafter. Never `rmSync` the well-known path.
   */
  function renameLockToTomb(lockPath: string, tomb: string): boolean {
    const until = Date.now() + 500;
    while (true) {
      try {
        renameSync(lockPath, tomb);
        return true;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return false;
        if (!lockBusy(code) || Date.now() >= until) return false;
        sleepSync(10);
      }
    }
  }

  /**
   * After a tomb rename: destroy only a matching stale/owned generation.
   * Mismatched tombs are restored to the well-known path when possible; on
   * EEXIST the tomb is left in place (fail closed) rather than deleted.
   */
  function settleTomb(
    lockPath: string,
    tomb: string,
    accept: (moved: { pid: number; at: number } | null) => boolean,
  ): boolean {
    const moved = readLockOwner(tomb);
    if (accept(moved)) {
      try {
        rmSync(tomb, { force: true });
      } catch {
        // Tomb is private; a leftover here does not affect exclusivity.
      }
      return true;
    }
    try {
      renameSync(tomb, lockPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST" || lockBusy(code)) {
        // Another live claim occupies the well-known path. Do not destroy the
        // tomb's possibly-live generation; leave it for operator cleanup.
        return false;
      }
      if (code !== "ENOENT") {
        return false;
      }
    }
    return false;
  }

  /**
   * Drop or reclaim a matching owner generation via rename-to-tomb. Cooperating
   * writers never remove the well-known path with `rmSync`, so a successor
   * published there after a final content check cannot be deleted by an older
   * observation (the old check-then-unlink interval is not part of this protocol).
   */
  function reclaimMatchingOwner(
    lockPath: string,
    expected: { pid: number; at: number },
  ): boolean {
    const current = readLockOwner(lockPath);
    if (
      !current ||
      current.pid !== expected.pid ||
      current.at !== expected.at
    ) {
      return false;
    }
    const tomb = lockTombPath(lockPath, "owner", expected);
    if (!renameLockToTomb(lockPath, tomb)) return false;
    return settleTomb(
      lockPath,
      tomb,
      (moved) =>
        !!moved && moved.pid === expected.pid && moved.at === expected.at,
    );
  }

  /**
   * Empty/malformed lock reclaim: rename aside only when still ownerless.
   * A tomb that gained a real owner record is restored (fail closed).
   */
  function reclaimIfStillOwnerless(lockPath: string): boolean {
    if (readLockOwner(lockPath)) return false;
    try {
      statSync(lockPath);
    } catch {
      return false;
    }
    if (readLockOwner(lockPath)) return false;
    const tomb = lockTombPath(lockPath, "empty");
    if (!renameLockToTomb(lockPath, tomb)) return false;
    return settleTomb(lockPath, tomb, (moved) => moved === null);
  }

  function tryReclaimStaleLock(lockPath: string): boolean {
    const owner = readLockOwner(lockPath);
    if (owner) {
      if (!ownerObservationIsStale(owner)) return false;
      return reclaimMatchingOwner(lockPath, owner);
    }
    try {
      if (Date.now() - statSync(lockPath).mtimeMs < LOCK_WAIT_MS) return false;
    } catch {
      return false;
    }
    return reclaimIfStillOwnerless(lockPath);
  }

  /**
   * Drop this process's lock only when the generation we published is still the
   * inode at the well-known path. Release uses the same rename-to-tomb rule as
   * reclaim so a waiter that already wx-created a successor cannot be removed
   * by a late owner unlink of the shared name.
   */
  function unlinkOwnedLock(
    lockPath: string,
    stamp: { pid: number; at: number },
  ): void {
    reclaimMatchingOwner(lockPath, stamp);
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
        // Empty leftovers can still be stolen after LOCK_WAIT_MS if a crash
        // or a still-empty file is old enough. Stale reclaim/release clear the
        // well-known path only by winning rename-to-tomb for a matching
        // generation; they never `rmSync` that path (so a live successor at
        // the name cannot be deleted by an older observation).
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
        if (tryReclaimStaleLock(lockPath)) {
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
