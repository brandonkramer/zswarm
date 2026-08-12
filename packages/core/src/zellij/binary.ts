import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export type ZellijExecResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export type ZellijExecFn = (
  args: string[],
  options: { timeoutMs: number },
) => Promise<ZellijExecResult>;

export const DEFAULT_TIMEOUT_MS = 15_000;
export const NOT_FOUND_EXIT = 127;

/** Expand a leading `~/` or `~\` using USERPROFILE/HOME. */
export function expandHomePath(
  input: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const trimmed = input.trim();
  if (!trimmed.startsWith("~/") && !trimmed.startsWith("~\\")) return trimmed;
  const home = env.USERPROFILE || env.HOME || homedir();
  if (!home) return trimmed;
  return join(home, trimmed.slice(2));
}

export function resolveZellijBinary(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromEnv = expandHomePath(
    (env.ZSWARM_BIN ?? env.ZSWARM_PATH ?? env.ZELLIJ_BIN ?? "")
      .trim()
      .replace(/^['"]|['"]$/g, ""),
    env,
  );
  if (fromEnv && existsSync(fromEnv)) {
    if (/\.cmd$/i.test(fromEnv)) {
      const exe = fromEnv.replace(/\.cmd$/i, ".exe");
      if (existsSync(exe)) return exe;
      const wingetExe = join(
        env.LOCALAPPDATA ||
          join(env.USERPROFILE || env.HOME || homedir(), "AppData", "Local"),
        "Zellij",
        "zellij.exe",
      );
      if (existsSync(wingetExe)) return wingetExe;
    }
    return fromEnv;
  }

  const home = env.USERPROFILE || env.HOME || homedir();
  const localAppData =
    env.LOCALAPPDATA || (home ? join(home, "AppData", "Local") : "");
  const candidates = [
    localAppData ? join(localAppData, "Zellij", "zellij.exe") : "",
    home ? join(home, ".local", "bin", "zellij") : "",
    home ? join(home, ".cargo", "bin", "zellij") : "",
    home ? join(home, ".cargo", "bin", "zellij.exe") : "",
    "/usr/local/bin/zellij",
    "/opt/homebrew/bin/zellij",
    ...(env.PATH ?? env.Path ?? "")
      .split(delimiter)
      .filter(Boolean)
      .flatMap((dir) =>
        process.platform === "win32"
          ? [join(dir, "zellij.exe"), join(dir, "zellij")]
          : [join(dir, "zellij")],
      ),
  ].filter(Boolean);

  for (const cand of candidates) {
    if (existsSync(cand)) return cand;
  }
  return process.platform === "win32" ? "zellij.exe" : "zellij";
}

export function sanitizeZellijEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: Record<string, string> = {};
  for (const key of Object.keys(env)) {
    const value = env[key];
    if (typeof value === "string") out[key] = value;
  }
  if (process.platform === "win32") {
    if (!out.SystemRoot && !out.SYSTEMROOT) {
      out.SystemRoot = process.env.SystemRoot || "C:\\Windows";
    }
    if (out.PATH && !out.Path) out.Path = out.PATH;
    if (out.Path && !out.PATH) out.PATH = out.Path;
  }
  return out;
}

/** execFile-backed runner; never rejects, so callers branch on `code`. */
export function defaultExec(
  zellijPath: string,
  env: NodeJS.ProcessEnv,
): ZellijExecFn {
  const cleanEnv = sanitizeZellijEnv(env);
  return (args, options) =>
    new Promise<ZellijExecResult>((resolve) => {
      execFile(
        zellijPath,
        args,
        {
          timeout: options.timeoutMs,
          maxBuffer: 8 * 1024 * 1024,
          windowsHide: true,
          env: cleanEnv,
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
              stderr: `${failure.code}: ${failure.message} (bin=${zellijPath})`,
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
              stderr: `zellij timed out after ${options.timeoutMs}ms`,
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
