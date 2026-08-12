import { execFile } from "node:child_process";

export type ExecResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export type ExecOptions = {
  timeoutMs: number;
  cwd?: string;
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
};

/**
 * Run the remote zellij over ssh. The whole invocation is quoted into a single
 * command string, because the remote login shell re-parses it.
 */
export function createSshExec(
  target: SshTarget,
  env: NodeJS.ProcessEnv,
): ExecFn {
  const runner = createExec(target.ssh, env);
  return (args, options) => {
    const remote = [target.remoteBin, ...args].map(shellQuote).join(" ");
    return runner([...target.options, target.host, remote], options);
  };
}

/**
 * execFile-backed runner for a fixed binary. Never rejects — callers branch on
 * `code`, and a missing binary surfaces as NOT_FOUND_EXIT.
 */
export function createExec(binPath: string, env: NodeJS.ProcessEnv): ExecFn {
  return (args, options) =>
    new Promise<ExecResult>((resolve) => {
      execFile(
        binPath,
        args,
        {
          timeout: options.timeoutMs,
          cwd: options.cwd,
          maxBuffer: 8 * 1024 * 1024,
          windowsHide: true,
          env,
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
            (failure.killed === true || typeof failure.signal === "string")
          ) {
            resolve({
              code: -1,
              stdout: String(stdout ?? ""),
              stderr: `${binPath} timed out after ${options.timeoutMs}ms`,
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
