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

export type ExecResult = {
  code: number;
  stdout: string;
  stderr: string;
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

export type SshExecFn = ExecFn & { ipcState: IpcDiscoveryState };

async function discoverRemoteIpc(
  runner: ExecFn,
  target: SshTarget,
  remaining: () => number,
  signal?: AbortSignal,
): Promise<IpcDirs | undefined> {
  const shell = inferRemoteShell({
    explicit: target.remoteShell,
    remoteBin: target.remoteBin,
    mode: target.mode,
  });
  // `auto` has no tmp yet, so a Windows host with remoteBin=zellij still looks
  // like Unix. Try both listings; pickIpcDirs ignores lines without --server.
  const probes =
    shell === "cmd"
      ? [windowsDiscoverRemote(), unixDiscoverRemote()]
      : [unixDiscoverRemote(), windowsDiscoverRemote()];
  for (const probe of probes) {
    if (signal?.aborted) return undefined;
    const left = remaining();
    if (left <= 0) return undefined;
    const result = await runner([...target.options, target.host, probe], {
      timeoutMs: left,
      signal,
    });
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
): SshExecFn {
  const runner = createExec(target.ssh, env);
  let cached: IpcDirs | undefined;
  let autoAttempted = false;
  const requestedTmp = target.tmp?.trim() || null;
  const ipcState: IpcDiscoveryState = {
    requested: requestedTmp,
    status:
      !requestedTmp
        ? "none"
        : requestedTmp.toLowerCase() === "auto"
          ? "none"
          : "skipped",
    ...(requestedTmp && requestedTmp.toLowerCase() !== "auto"
      ? { tmp: requestedTmp, socketDir: "" }
      : {}),
  };

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
    if (cached) {
      ipcState.status = "resolved";
      ipcState.tmp = cached.tmp;
      ipcState.socketDir = cached.socketDir;
      return cached;
    }
    // Do not re-probe after a failed/expired/cancelled attempt on this exec.
    if (autoAttempted) return undefined;
    if (signal?.aborted) {
      ipcState.status = "cancelled";
      return undefined;
    }
    if (remaining() <= 0) {
      ipcState.status = "expired";
      return undefined;
    }
    autoAttempted = true;
    const dirs = await discoverRemoteIpc(runner, target, remaining, signal);
    if (signal?.aborted) {
      ipcState.status = "cancelled";
      return undefined;
    }
    if (dirs) {
      cached = dirs;
      ipcState.status = "resolved";
      ipcState.tmp = dirs.tmp;
      ipcState.socketDir = dirs.socketDir;
      return dirs;
    }
    ipcState.status = remaining() <= 0 ? "expired" : "failed";
    return undefined;
  }

  const exec: SshExecFn = async (args, options) => {
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
  };
  exec.ipcState = ipcState;
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
      const missing = err.code === "ENOENT" || err.code === "ENOTDIR";
      finish({
        code: missing ? NOT_FOUND_EXIT : 1,
        stdout: "",
        stderr: `${err.code ?? "error"}: ${err.message} (bin=${binPath})`,
      });
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
          const missing =
            failure.code === "ENOENT" || failure.code === "ENOTDIR";
          resolve({
            code: missing ? NOT_FOUND_EXIT : 1,
            stdout: "",
            stderr: `${failure.code}: ${failure.message} (bin=${binPath})`,
          });
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
