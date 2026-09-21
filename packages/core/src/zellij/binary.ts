import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { ZellijError } from "../errors.js";
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

/**
 * True when a path (or basename) is the zswarm CLI rather than Zellij.
 * Setting ZSWARM_BIN to zswarm makes `list-sessions --short` fail with
 * "unknown arg: --short" because zswarm re-parses argv as its own CLI.
 */
export function looksLikeZswarmBinary(path: string): boolean {
  const trimmed = path.trim();
  const base = basename(trimmed).toLowerCase();
  // Windows paths on a Linux host still use backslashes in env values.
  const winBase =
    trimmed.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? base;
  const name = winBase || base;
  if (/^zswarm(\.(exe|cmd|js|mjs|cjs))?$/.test(name)) return true;
  // Native binaries are never the Node CLI wrapper.
  if (/\.(exe|dll|so|dylib)$/i.test(name)) return false;
  if (name === "zellij") return false;
  // Shebang wrappers may keep another basename; sniff a short readable prefix.
  try {
    if (!existsSync(trimmed)) return false;
    const head = readFileSync(trimmed, { encoding: "utf8" }).slice(0, 400);
    if (head.includes("\0")) return false;
    return /@zswarm\/cli/.test(head) || /usage:\s*zswarm/i.test(head);
  } catch {
    return false;
  }
}

export function assertZellijBinaryPath(path: string): void {
  if (!looksLikeZswarmBinary(path)) return;
  throw new ZellijError(
    "zellij_wrong_bin",
    `ZSWARM_BIN/ZSWARM_PATH points at zswarm (${path}), not Zellij. Set it to the zellij binary (e.g. ~/.local/bin/zellij)`,
  );
}

/**
 * ZSWARM_SSH is a destination, not a full ssh argv.
 * Accept `user@host` or an SSH config alias; put flags in ZSWARM_SSH_OPTS.
 */
export function validateSshDestination(raw: string): string {
  const host = raw.trim();
  if (!host) {
    throw new ZellijError("bad_ssh", "ZSWARM_SSH is empty");
  }
  if (/^ssh(\s|$)/i.test(host)) {
    throw new ZellijError(
      "bad_ssh",
      `ZSWARM_SSH should be user@host or an SSH alias, not a full ssh command. Put flags in ZSWARM_SSH_OPTS. Got: ${JSON.stringify(host)}`,
    );
  }
  if (/\s/.test(host)) {
    throw new ZellijError(
      "bad_ssh",
      `ZSWARM_SSH must be a single destination (user@host or alias); put options in ZSWARM_SSH_OPTS. Got: ${JSON.stringify(host)}`,
    );
  }
  if (/[;|&$<>()]/.test(host)) {
    throw new ZellijError(
      "bad_ssh",
      `ZSWARM_SSH contains shell metacharacters; expected user@host or an SSH alias. Got: ${JSON.stringify(host)}`,
    );
  }
  return host;
}

export function validateSshMode(raw: string): "ssh" | "interactive" {
  const mode = raw.trim().toLowerCase();
  if (!mode || mode === "ssh") return "ssh";
  if (mode === "interactive") return "interactive";
  throw new ZellijError(
    "bad_ssh_mode",
    `ZSWARM_SSH_MODE must be "interactive" or "ssh" (or unset); got ${JSON.stringify(raw.trim())}`,
  );
}

/** Cache of `zellij --version` probes keyed by resolved binary / ssh path. */
const identityCache = new Map<string, Promise<void>>();

/**
 * Confirm the resolved binary is Zellij (not zswarm). Cached per path.
 * Injected test execs skip this when the caller never asks.
 */
export function ensureZellijIdentity(
  exec: ExecFn,
  zellijPath: string,
  timeoutMs = 3_000,
): Promise<void> {
  const cached = identityCache.get(zellijPath);
  if (cached) return cached;
  const probe = (async () => {
    assertZellijBinaryPath(zellijPath);
    // ssh:// paths are probed on the remote via the same exec wrapper.
    const result = await exec(["--version"], {
      timeoutMs: Math.min(timeoutMs, 5_000),
    });
    const text = `${result.stdout}\n${result.stderr}`;
    if (/usage:\s*zswarm/i.test(text) || /unknown arg:/i.test(text)) {
      throw new ZellijError(
        "zellij_wrong_bin",
        `resolved binary is zswarm, not Zellij (${zellijPath}). Set ZSWARM_BIN to the zellij executable`,
      );
    }
    if (result.code === NOT_FOUND_EXIT) {
      throw new ZellijError(
        "zellij_missing",
        `zellij binary not found (${zellijPath}); install Zellij ≥ 0.42, add it to PATH, or set ZSWARM_BIN / ZSWARM_PATH`,
      );
    }
    if (result.code === 0 && /\bzellij\b/i.test(text)) return;
    // Nonzero without a clear zswarm signature: leave it to the real call.
  })();
  identityCache.set(zellijPath, probe);
  return probe.catch((err) => {
    identityCache.delete(zellijPath);
    throw err;
  });
}

/** Test helper: drop cached identity probes. */
export function resetZellijIdentityCache(): void {
  identityCache.clear();
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
    assertZellijBinaryPath(fromEnv);
    if (/\.cmd$/i.test(fromEnv)) {
      const exe = fromEnv.replace(/\.cmd$/i, ".exe");
      if (existsSync(exe)) {
        assertZellijBinaryPath(exe);
        return exe;
      }
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
  const raw = env.ZSWARM_SSH?.trim();
  if (!raw) return null;
  const host = validateSshDestination(raw);
  const options = parseSshOpts(env.ZSWARM_SSH_OPTS ?? "");
  if (!options.some((o) => o.startsWith("BatchMode"))) {
    options.unshift("-o", "BatchMode=yes");
  }
  const shellRaw = (env.ZSWARM_REMOTE_SHELL ?? "").trim().toLowerCase();
  const mode = validateSshMode(env.ZSWARM_SSH_MODE ?? "");
  const tmpRaw = env.ZSWARM_TMP?.trim();
  const interactive = mode === "interactive";
  return {
    ssh: env.ZSWARM_SSH_BIN?.trim() || "ssh",
    host,
    remoteBin: env.ZSWARM_REMOTE_BIN?.trim() || "zellij",
    options,
    // Interactive tasks do not inherit the desktop TEMP; discover it unless set.
    tmp: tmpRaw || (interactive ? "auto" : undefined),
    mode,
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
