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
/** Where a missing/wrong-Zellij failure was produced. */
export type ZellijFailureOrigin = "local_spawn" | "local_preflight" | "remote";

export const DEFAULT_TIMEOUT_MS = 15_000;
export { NOT_FOUND_EXIT };

/** Local Node spawn failure vs a process that actually started. */
export function originFromExecResult(
  result: ExecResult,
): Exclude<ZellijFailureOrigin, "local_preflight"> {
  return result.spawn?.origin === "local" ? "local_spawn" : "remote";
}

export function zellijExecDetails(result: ExecResult): Record<string, unknown> {
  const origin = originFromExecResult(result);
  return result.spawn
    ? { origin, spawn: { origin: result.spawn.origin, errno: result.spawn.errno, bin: result.spawn.bin } }
    : { origin };
}

export function zellijMissingError(zellijPath: string, result: ExecResult): ZellijError {
  return new ZellijError(
    "zellij_missing",
    `zellij binary not found (${zellijPath}); install Zellij ≥ 0.42, add it to PATH, or set ZSWARM_BIN / ZSWARM_PATH`,
    zellijExecDetails(result),
  );
}

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
    { origin: "local_preflight", bin: path },
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
  // Leading dashes are SSH options (`-V`, `-F…`, `-o…`), not destinations.
  if (host.startsWith("-")) {
    throw new ZellijError(
      "bad_ssh",
      `ZSWARM_SSH looks like an SSH option (${JSON.stringify(host)}); put flags in ZSWARM_SSH_OPTS and set ZSWARM_SSH to user@host or an alias`,
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

/** Cache of verified `zellij --version` probes keyed by target identity. */
const identityCache = new Set<string>();

/** True when `--version` output is positively Zellij. */
export function isZellijVersionOutput(stdout: string, stderr = ""): boolean {
  const text = `${stdout}\n${stderr}`;
  return /\bzellij\s+\d+\.\d+/i.test(text) || /^\s*zellij\b/im.test(stdout);
}

/**
 * Cache key covering the resolved binary and SSH routing that can change the
 * actual remote executable (opts, mode, remote bin).
 */
export function identityCacheKey(
  zellijPath: string,
  ssh?: {
    host: string;
    options: string[];
    mode?: string;
    remoteBin?: string;
    /** SSH client binary (`SshTarget.ssh`). */
    ssh?: string;
    sshBin?: string;
    remoteShell?: string;
  } | null,
): string {
  if (!ssh) return JSON.stringify([zellijPath]);
  return JSON.stringify([
    zellijPath,
    ssh.host,
    ssh.remoteBin ?? "",
    ssh.mode ?? "ssh",
    ssh.options,
    ssh.sshBin ?? ssh.ssh ?? "",
    ssh.remoteShell ?? "",
  ]);
}

/**
 * Confirm the resolved binary is Zellij. Only verified identities are cached.
 * Transport timeouts leave the cache empty so a later call can retry.
 * Returns false when verification is unresolved; only true is cached.
 * In-flight probes are never shared — each caller supplies its own timeout.
 */
export async function ensureZellijIdentity(
  exec: ExecFn,
  zellijPath: string,
  timeoutMs = 3_000,
  cacheKey = zellijPath,
  signal?: AbortSignal,
): Promise<boolean> {
  if (identityCache.has(cacheKey)) return true;
  if (signal?.aborted) return false;
  assertZellijBinaryPath(zellijPath);
  const result = await exec(["--version"], {
    timeoutMs: Math.min(timeoutMs, 5_000),
    signal,
  });
  const text = `${result.stdout}\n${result.stderr}`;
  if (/usage:\s*zswarm/i.test(text) || /unknown arg:/i.test(text)) {
    throw new ZellijError(
      "zellij_wrong_bin",
      `resolved binary is zswarm, not Zellij (${zellijPath}). Set ZSWARM_BIN to the zellij executable`,
      zellijExecDetails(result),
    );
  }
  if (result.code === NOT_FOUND_EXIT) {
    throw zellijMissingError(zellijPath, result);
  }
  if (result.code === 0) {
    if (signal?.aborted) return false;
    if (isZellijVersionOutput(result.stdout, result.stderr)) {
      identityCache.add(cacheKey);
      return true;
    }
    throw new ZellijError(
      "zellij_wrong_bin",
      `resolved binary is not Zellij (${zellijPath}); --version returned: ${result.stdout.trim() || result.stderr.trim() || "empty"}`,
      zellijExecDetails(result),
    );
  }
  // Timeout / transport failure: leave unresolved so a later call retries.
  return false;
}

/**
 * Probe that the target understands the session-list flags we rely on.
 * Cached with the same key as identity once verified.
 * Returns false when the transport cannot verify support.
 */
const capabilityCache = new Set<string>();

export async function ensureZellijCapabilities(
  exec: ExecFn,
  zellijPath: string,
  timeoutMs = 3_000,
  cacheKey = zellijPath,
  signal?: AbortSignal,
): Promise<boolean> {
  if (capabilityCache.has(cacheKey)) return true;
  if (signal?.aborted) return false;
  const result = await exec(["list-sessions", "--help"], {
    timeoutMs: Math.min(timeoutMs, 5_000),
    signal,
  });
  const text = `${result.stdout}\n${result.stderr}`;
  if (/usage:\s*zswarm/i.test(text)) {
    throw new ZellijError(
      "zellij_wrong_bin",
      `resolved binary is zswarm, not Zellij (${zellijPath})`,
      zellijExecDetails(result),
    );
  }
  if (result.code === NOT_FOUND_EXIT) {
    throw zellijMissingError(zellijPath, result);
  }
  // Require the flags this client always passes.
  if (
    result.code === 0 &&
    /--no-formatting/i.test(text) &&
    /list-sessions/i.test(text)
  ) {
    if (signal?.aborted) return false;
    capabilityCache.add(cacheKey);
    return true;
  }
  if (result.code === 0) {
    throw new ZellijError(
      "zellij_incompatible",
      `Zellij at ${zellijPath} does not advertise list-sessions --no-formatting; upgrade Zellij (≥ 0.42) or zswarm`,
      zellijExecDetails(result),
    );
  }
  // Soft: leave unresolved on transport failure.
  return false;
}

/**
 * Identity and capability are independent reads. Run them together under one
 * remaining budget; do not share in-flight work with another caller.
 */
export async function ensureZellijProbes(
  exec: ExecFn,
  zellijPath: string,
  timeoutMs = 3_000,
  cacheKey = zellijPath,
  signal?: AbortSignal,
): Promise<{ identity: boolean; capabilities: boolean }> {
  if (signal?.aborted) return { identity: false, capabilities: false };
  const probeTimeout = Math.min(timeoutMs, 5_000);
  // Settle both so a wrong-bin throw does not leave the other SSH probe running.
  const settled = await Promise.allSettled([
    ensureZellijIdentity(exec, zellijPath, probeTimeout, cacheKey, signal),
    ensureZellijCapabilities(exec, zellijPath, probeTimeout, cacheKey, signal),
  ]);
  if (settled[0].status === "rejected") throw settled[0].reason;
  if (settled[1].status === "rejected") throw settled[1].reason;
  return { identity: settled[0].value, capabilities: settled[1].value };
}

/** Test helper: drop cached identity/capability probes. */
export function resetZellijIdentityCache(): void {
  identityCache.clear();
  capabilityCache.clear();
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
