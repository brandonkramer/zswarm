import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import {
  createExec,
  NOT_FOUND_EXIT,
  type ExecFn,
  type ExecResult,
} from "../exec.js";

export type ZellijExecResult = ExecResult;
export type ZellijExecFn = ExecFn;

export const DEFAULT_TIMEOUT_MS = 15_000;
export { NOT_FOUND_EXIT };

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

/** Runner bound to the resolved zellij binary and a cleaned environment. */
export function defaultExec(
  zellijPath: string,
  env: NodeJS.ProcessEnv,
): ZellijExecFn {
  return createExec(zellijPath, sanitizeZellijEnv(env));
}
