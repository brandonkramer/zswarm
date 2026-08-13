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

async function discoverRemoteIpc(
  runner: ExecFn,
  target: SshTarget,
  timeoutMs: number,
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
    const result = await runner([...target.options, target.host, probe], {
      timeoutMs,
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
): ExecFn {
  const runner = createExec(target.ssh, env);
  let cached: IpcDirs | undefined;

  async function resolveIpc(timeoutMs: number): Promise<IpcDirs | undefined> {
    const requested = target.tmp?.trim();
    if (!requested) return undefined;
    if (requested.toLowerCase() !== "auto") {
      return { tmp: requested, socketDir: "" };
    }
    if (cached) return cached;
    const dirs = await discoverRemoteIpc(runner, target, timeoutMs);
    if (dirs) cached = dirs;
    return dirs;
  }

  return async (args, options) => {
    const ipc = await resolveIpc(options.timeoutMs);
    const remote = buildSshRemoteCommand(
      target,
      args,
      ipc?.tmp,
      options.timeoutMs,
      ipc?.socketDir,
    );
    return runner([...target.options, target.host, remote], options);
  };
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
