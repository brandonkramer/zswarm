import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import {
  createExec,
  createSshExec,
  NOT_FOUND_EXIT,
  type ExecFn,
  type ExecResult,
  type SshTarget,
} from "../exec.js";
import { applyIpcTmpEnv } from "./ipc.js";

export { createSshExec, type SshTarget };

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
  const withTmp = applyIpcTmpEnv(env);
  const out: Record<string, string> = {};
  for (const key of Object.keys(withTmp)) {
    const value = withTmp[key];
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

/**
 * Remote crew: `ZSWARM_SSH=user@host` routes every zellij call over ssh.
 * `ZSWARM_SSH_OPTS` is split like a shell so quoted paths stay one arg;
 * `BatchMode` keeps it non-interactive.
 * `ZSWARM_TMP` points at the interactive session's temp (or `auto` to discover).
 * `ZSWARM_SSH_MODE=interactive` runs each call in the Windows desktop session.
 */
export function parseSshOpts(raw: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        cur += ch;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (cur.length > 0) {
        out.push(cur);
        cur = "";
      }
    } else {
      cur += ch;
    }
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

export function resolveSshTarget(
  env: NodeJS.ProcessEnv = process.env,
): SshTarget | null {
  const host = env.ZSWARM_SSH?.trim();
  if (!host) return null;
  const options = parseSshOpts(env.ZSWARM_SSH_OPTS ?? "");
  if (!options.some((o) => o.startsWith("BatchMode"))) {
    options.unshift("-o", "BatchMode=yes");
  }
  const shellRaw = (env.ZSWARM_REMOTE_SHELL ?? "").trim().toLowerCase();
  const modeRaw = (env.ZSWARM_SSH_MODE ?? "").trim().toLowerCase();
  const tmpRaw = env.ZSWARM_TMP?.trim();
  const interactive = modeRaw === "interactive";
  return {
    ssh: env.ZSWARM_SSH_BIN?.trim() || "ssh",
    host,
    remoteBin: env.ZSWARM_REMOTE_BIN?.trim() || "zellij",
    options,
    // Interactive tasks do not inherit the desktop TEMP; discover it unless set.
    tmp: tmpRaw || (interactive ? "auto" : undefined),
    mode: interactive ? "interactive" : "ssh",
    remoteShell: shellRaw === "cmd" || shellRaw === "sh" ? shellRaw : undefined,
  };
}

/** Runner bound to the resolved zellij binary and a cleaned environment. */
export function defaultExec(
  zellijPath: string,
  env: NodeJS.ProcessEnv,
): ZellijExecFn {
  return createExec(zellijPath, sanitizeZellijEnv(env));
}
