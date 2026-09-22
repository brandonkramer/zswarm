import { execFile, spawn } from "node:child_process";
import {
  cmdQuote,
  inferRemoteShell,
  parseZellijServerPaths,
  pickIpcDirs,
  unixDiscoverRemote,
  windowsDiscoverRemote,
  windowsInteractiveRemote,
  wrapWithTmpEnv,
  type IpcDirs,
  type RemoteShell,
} from "./zellij/ipc.js";

export type ExecSpawnFailure = {
  /** Node could not start this process. Distinct from a remote 127. */
  origin: "local";
  errno: string;
  bin: string;
};

export type ExecResult = {
  code: number;
  stdout: string;
  stderr: string;
  /** Present only when this host failed to spawn the binary. */
  spawn?: ExecSpawnFailure;
};

export type ExecOptions = {
  timeoutMs: number;
  cwd?: string;
  /** Overlay on the runner's env (e.g. GIT_INDEX_FILE for a scratch index). */
  env?: NodeJS.ProcessEnv;
  /**
   * Stop as soon as the accumulated stdout satisfies this, instead of waiting
   * for the process to exit. `zellij pipe` answers in milliseconds but stays
   * resident when it has no terminal, so waiting for exit means waiting for the
   * timeout.
   */
  until?: (stdout: string) => boolean;
  /** Kill the child when aborted (MCP cancellation). */
  signal?: AbortSignal;
};

export type ExecFn = (
  args: string[],
  options: ExecOptions,
) => Promise<ExecResult>;

export const NOT_FOUND_EXIT = 127;

function localSpawnResult(
  err: Error & { code?: unknown },
  binPath: string,
): ExecResult {
  const errno = typeof err.code === "string" && err.code ? err.code : "error";
  const missing = errno === "ENOENT" || errno === "ENOTDIR";
  return {
    code: missing ? NOT_FOUND_EXIT : 1,
    stdout: "",
    stderr: `${errno}: ${err.message} (bin=${binPath})`,
    spawn: { origin: "local", errno, bin: binPath },
  };
}

/** POSIX single-quoting, for building a command line the remote shell parses. */
export function shellQuote(arg: string): string {
  if (arg === "") return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export type SshTarget = {
  ssh: string;
  host: string;
  remoteBin: string;
  options: string[];
  /** Concrete IPC temp, or `auto` to read `--server` off a live zellij process. */
  tmp?: string;
  /** `interactive` runs the CLI in the Windows desktop session (schtasks /IT). */
  mode?: "ssh" | "interactive";
  remoteShell?: "cmd" | "sh";
};

export function quoteRemoteArg(arg: string, shell: RemoteShell): string {
  return shell === "cmd" ? cmdQuote(arg) : shellQuote(arg);
}

/**
 * The string `ssh host <this>` runs. Tests assert this rather than spawning ssh.
 */
export function buildSshRemoteCommand(
  target: SshTarget,
  args: string[],
  tmp: string | undefined,
  timeoutMs: number,
  socketDir?: string,
): string {
  const shell = inferRemoteShell({
    explicit: target.remoteShell,
    tmp,
    remoteBin: target.remoteBin,
    mode: target.mode,
  });
  const zellij = [target.remoteBin, ...args]
    .map((arg) => quoteRemoteArg(arg, shell))
    .join(" ");
  const withTmp = tmp ? wrapWithTmpEnv(zellij, tmp, shell, socketDir) : zellij;
  if (target.mode === "interactive") {
    return windowsInteractiveRemote(withTmp, timeoutMs);
  }
  // Windows OpenSSH often logs into PowerShell; `set "TEMP=…"` only works in cmd.
  if (shell === "cmd") {
    return `cmd.exe /c ${cmdQuote(withTmp)}`;
  }
  return withTmp;
}

/** Outcome of `ZSWARM_TMP=auto` discovery for session diagnostics. */
export type IpcDiscoveryState = {
  requested: string | null;
  /** `none` = no tmp routing; `resolved`/`failed` only after an auto attempt. */
  status: "none" | "skipped" | "resolved" | "failed" | "cancelled" | "expired";
  tmp?: string;
  socketDir?: string;
};

export type SshExecFn = ExecFn & {
  ipcState: IpcDiscoveryState;
  /**
   * Resolve `ZSWARM_TMP=auto` once under this caller's budget before parallel
   * identity/capability probes. Independent of other callers' in-flight work.
   */
  prepareIpc: (
    timeoutMs: number,
    signal?: AbortSignal,
  ) => Promise<IpcDirs | undefined>;
};

/** Positive `auto` IPC hits only; failures/cancels never enter this map. */
export const DEFAULT_IPC_DISCOVERY_TTL_MS = 15_000;
export const DEFAULT_IPC_DISCOVERY_CACHE_LIMIT = 512;

type IpcCacheEntry = { dirs: IpcDirs; expiresAt: number };

const ipcDiscoveryCache = new Map<string, IpcCacheEntry>();
let ipcDiscoveryTtlMs = DEFAULT_IPC_DISCOVERY_TTL_MS;
let ipcDiscoveryCacheLimit = DEFAULT_IPC_DISCOVERY_CACHE_LIMIT;

const IPC_USER_ENV = [
  "USER",
  "USERNAME",
  "LOGNAME",
  "HOME",
  "USERPROFILE",
  "USERDOMAIN",
  "SSH_AUTH_SOCK",
  "PATH",
  "Path",
  "XDG_CONFIG_HOME",
] as const;

/** Fully scoped key so hosts / SSH bins / remote shells / users never collide. */
export function ipcDiscoveryCacheKey(
  target: SshTarget,
  env: NodeJS.ProcessEnv = {},
): string {
  const requested = target.tmp?.trim() ?? "";
  const user = IPC_USER_ENV.map((name) => env[name] ?? "");
  return JSON.stringify([
    target.ssh,
    target.host,
    target.options,
    target.remoteBin,
    target.remoteShell ?? "",
    target.mode ?? "ssh",
    requested.toLowerCase() === "auto" ? "auto" : requested,
    user,
  ]);
}

/**
 * Probe list for `ZSWARM_TMP=auto`. Known Windows (cmd / interactive / .exe)
 * skips the Unix `ps` fallback; explicit `sh` skips PowerShell. Unknown
 * `zellij` still tries both — a Windows host with remoteBin=zellij looks Unix.
 */
export function ipcDiscoveryProbes(target: SshTarget): string[] {
  const shell = inferRemoteShell({
    explicit: target.remoteShell,
    remoteBin: target.remoteBin,
    mode: target.mode,
  });
  const windows = windowsDiscoverRemote();
  const unix = unixDiscoverRemote();
  if (shell === "cmd") return [windows];
  if (target.remoteShell === "sh") return [unix];
  return [unix, windows];
}

export function resetIpcDiscoveryCache(): void {
  ipcDiscoveryCache.clear();
  ipcDiscoveryTtlMs = DEFAULT_IPC_DISCOVERY_TTL_MS;
  ipcDiscoveryCacheLimit = DEFAULT_IPC_DISCOVERY_CACHE_LIMIT;
}

/** Test helper: shrink the positive-hit TTL without exposing the map. */
export function setIpcDiscoveryTtlMs(ttlMs: number): void {
  ipcDiscoveryTtlMs = Math.max(0, ttlMs);
}

export function peekIpcDiscoveryCache(key: string): IpcDirs | undefined {
  const entry = ipcDiscoveryCache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    ipcDiscoveryCache.delete(key);
    return undefined;
  }
  return { tmp: entry.dirs.tmp, socketDir: entry.dirs.socketDir };
}

/**
 * Canonical SSH + resolved IPC namespace. Listing caches should hash this
 * (or `ipcState.tmp` / `socketDir` after a refreshed read) so a warmed
 * socket context matches across `createSshExec` instances.
 */
export function sshIpcContextKey(
  target: SshTarget,
  env: NodeJS.ProcessEnv = {},
  ipc?: { tmp?: string; socketDir?: string } | null,
): string {
  return JSON.stringify([ipcDiscoveryCacheKey(target, env), ipc?.tmp ?? "", ipc?.socketDir ?? ""]);
}

/** Test helper: shrink the positive-hit map so eviction is observable. */
export function setIpcDiscoveryCacheLimit(limit: number): void {
  ipcDiscoveryCacheLimit = Math.max(1, limit);
}

export function ipcDiscoveryCacheSize(): number {
  return ipcDiscoveryCache.size;
}

function storeIpcDiscovery(key: string, dirs: IpcDirs): void {
  ipcDiscoveryCache.delete(key);
  ipcDiscoveryCache.set(key, {
    dirs: { ...dirs },
    expiresAt: Date.now() + ipcDiscoveryTtlMs,
  });
  while (ipcDiscoveryCache.size > ipcDiscoveryCacheLimit) {
    ipcDiscoveryCache.delete(ipcDiscoveryCache.keys().next().value!);
  }
}

async function discoverRemoteIpc(
  runner: ExecFn,
  target: SshTarget,
  remaining: () => number,
  signal?: AbortSignal,
): Promise<IpcDirs | undefined> {
  const probes = ipcDiscoveryProbes(target);
  for (const probe of probes) {
    if (signal?.aborted) return undefined;
    const left = remaining();
    if (left <= 0) return undefined;
    const result = await runner([...target.options, target.host, probe], {
      timeoutMs: left,
      signal,
    });
    if (result.code !== 0) continue;
    if (remaining() <= 0) return undefined;
    const dirs = pickIpcDirs(parseZellijServerPaths(result.stdout));
    if (dirs) return dirs;
  }
  return undefined;
}

/**
 * Run the remote zellij over ssh. The whole invocation is quoted into a single
 * command string, because the remote login shell re-parses it.
 */
export function createSshExec(
  target: SshTarget,
  env: NodeJS.ProcessEnv,
  options: { pinIpc?: boolean } = {},
): SshExecFn {
  const runner = createExec(target.ssh, env);
  const cacheKey = ipcDiscoveryCacheKey(target, env);
  let autoFailed = false;
  let pinnedIpc: IpcDirs | undefined;
  const ipcState: IpcDiscoveryState = {
    requested: null,
    status: "none",
  };

  function adopt(dirs: IpcDirs): IpcDirs {
    if (options.pinIpc) {
      pinnedIpc ??= { ...dirs };
      dirs = pinnedIpc;
    }
    autoFailed = false;
    ipcState.status = "resolved";
    ipcState.tmp = dirs.tmp;
    ipcState.socketDir = dirs.socketDir;
    return { ...dirs };
  }

  /** Seed from a positive hit; unpinned execs drop resolved dirs after TTL. */
  function refreshIpcView(): IpcDiscoveryState {
    const requested = target.tmp?.trim() || null;
    ipcState.requested = requested;
    if (!requested) {
      ipcState.status = "none";
      delete ipcState.tmp;
      delete ipcState.socketDir;
      return ipcState;
    }
    if (requested.toLowerCase() !== "auto") {
      ipcState.status = "skipped";
      ipcState.tmp = requested;
      ipcState.socketDir = "";
      return ipcState;
    }
    // A high-level client pins its namespace so pane lookup and the following
    // write cannot switch sockets when another caller refreshes discovery.
    if (pinnedIpc) return ipcState;
    // Diagnostics describe this exec's last attempt, not a sibling's later
    // success. A subsequent actual invocation may adopt a positive cache hit.
    if (autoFailed) return ipcState;
    const cached = peekIpcDiscoveryCache(cacheKey);
    if (cached) {
      adopt(cached);
      return ipcState;
    }
    if (ipcState.status === "resolved") {
      ipcState.status = "none";
      delete ipcState.tmp;
      delete ipcState.socketDir;
    }
    return ipcState;
  }

  refreshIpcView();

  async function resolveIpc(
    remaining: () => number,
    signal?: AbortSignal,
  ): Promise<IpcDirs | undefined> {
    const requested = target.tmp?.trim();
    if (!requested) {
      ipcState.requested = null;
      ipcState.status = "none";
      return undefined;
    }
    ipcState.requested = requested;
    if (requested.toLowerCase() !== "auto") {
      ipcState.status = "skipped";
      ipcState.tmp = requested;
      ipcState.socketDir = "";
      return { tmp: requested, socketDir: "" };
    }
    if (pinnedIpc) return adopt(pinnedIpc);
    const cached = peekIpcDiscoveryCache(cacheKey);
    if (cached) return adopt(cached);
    // Do not re-probe after a failed/expired/cancelled attempt on this exec.
    // A later createSshExec with the same key still probes — failures are not
    // stored, and in-flight work is never shared across callers' budgets.
    if (autoFailed) return undefined;
    if (signal?.aborted) {
      autoFailed = true;
      ipcState.status = "cancelled";
      return undefined;
    }
    if (remaining() <= 0) {
      autoFailed = true;
      ipcState.status = "expired";
      return undefined;
    }
    const dirs = await discoverRemoteIpc(runner, target, remaining, signal);
    // Another probe on this client may have pinned a namespace while we were
    // waiting. Its first positive result wins, even if this probe failed.
    if (pinnedIpc) return adopt(pinnedIpc);
    if (signal?.aborted) {
      autoFailed = true;
      ipcState.status = "cancelled";
      return undefined;
    }
    if (dirs) {
      if (remaining() <= 0) {
        autoFailed = true;
        ipcState.status = "expired";
        return undefined;
      }
      storeIpcDiscovery(cacheKey, dirs);
      return adopt(dirs);
    }
    autoFailed = true;
    ipcState.status = remaining() <= 0 ? "expired" : "failed";
    return undefined;
  }

  const exec = (async (args: string[], options: ExecOptions) => {
    const deadline = Date.now() + options.timeoutMs;
    const remaining = (): number => Math.max(0, deadline - Date.now());
    const ipc = await resolveIpc(remaining, options.signal);
    if (options.signal?.aborted) {
      return {
        code: -1,
        stdout: "",
        stderr: `${target.ssh} cancelled`,
      };
    }
    const left = remaining();
    // Do not launch the target command after the caller's budget is gone —
    // especially after two discovery probes ate the whole timeout.
    if (left <= 0) {
      return {
        code: -1,
        stdout: "",
        stderr: `${target.ssh} timed out after ${options.timeoutMs}ms`,
      };
    }
    // auto discovery failed: still run, but callers read ipcState for reachability.
    const remote = buildSshRemoteCommand(
      target,
      args,
      ipc?.tmp,
      left,
      ipc?.socketDir,
    );
    return runner([...target.options, target.host, remote], {
      ...options,
      timeoutMs: left,
    });
  }) as SshExecFn;
  Object.defineProperty(exec, "ipcState", {
    enumerable: true,
    configurable: true,
    get(): IpcDiscoveryState {
      return { ...refreshIpcView() };
    },
  });
  exec.prepareIpc = (timeoutMs, signal) => {
    const deadline = Date.now() + timeoutMs;
    return resolveIpc(() => Math.max(0, deadline - Date.now()), signal);
  };
  return exec;
}

/** Read stdout until the answer is in hand, then stop caring about the child. */
function runUntil(
  binPath: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  options: ExecOptions & { until: (stdout: string) => boolean },
): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve) => {
    const child = spawn(binPath, args, {
      env: options.env ? { ...env, ...options.env } : env,
      cwd: options.cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: ExecResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      child.kill();
      resolve(result);
    };
    const onAbort = (): void =>
      finish({
        code: -1,
        stdout,
        stderr: `${binPath} cancelled`,
      });
    const timer = setTimeout(
      () =>
        finish({
          code: -1,
          stdout,
          stderr: `${binPath} timed out after ${options.timeoutMs}ms`,
        }),
      options.timeoutMs,
    );
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (err: Error & { code?: string }) => {
      finish(localSpawnResult(err, binPath));
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (options.until(stdout)) finish({ code: 0, stdout, stderr });
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => finish({ code: code ?? 0, stdout, stderr }));
  });
}

/**
 * execFile-backed runner for a fixed binary. Never rejects — callers branch on
 * `code`, and a missing binary surfaces as NOT_FOUND_EXIT.
 */
function runToExit(
  binPath: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  options: ExecOptions,
): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve) => {
    execFile(
      binPath,
      args,
      {
        timeout: options.timeoutMs,
        cwd: options.cwd,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
        signal: options.signal,
        env: options.env ? { ...env, ...options.env } : env,
      },
      (error, stdout, stderr) => {
        const failure = error as
          | (Error & { code?: unknown; killed?: boolean; signal?: string })
          | null;
        if (failure && typeof failure.code === "string") {
          resolve(localSpawnResult(failure, binPath));
          return;
        }
        if (
          failure &&
          (failure.killed === true ||
            typeof failure.signal === "string" ||
            failure.name === "AbortError")
        ) {
          resolve({
            code: -1,
            stdout: String(stdout ?? ""),
            stderr:
              failure.name === "AbortError"
                ? `${binPath} cancelled`
                : `${binPath} timed out after ${options.timeoutMs}ms`,
          });
          return;
        }
        const code =
          failure && typeof failure.code === "number"
            ? failure.code
            : failure
              ? 1
              : 0;
        resolve({
          code,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
        });
      },
    );
  });
}

export function createExec(binPath: string, env: NodeJS.ProcessEnv): ExecFn {
  return (args, options) => {
    const until = options.until;
    return until
      ? runUntil(binPath, args, env, { ...options, until })
      : runToExit(binPath, args, env, options);
  };
}
