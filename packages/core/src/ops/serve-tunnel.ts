import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { connect, createServer } from "node:net";
import { ZellijError } from "../errors.js";
import { parseSshOpts } from "../zellij/binary.js";
import { fail } from "./util.js";
import {
  callServe,
  formatListenLabel,
  parseListenAddress,
  probeServe,
  type ProbeServeOptions,
  type ServeHelloData,
} from "./serve.js";
import type { OpsResult } from "./types.js";

export const DEFAULT_SSH_SERVE_PORT = parseListenAddress(undefined).port;
/** Ordinary OpenSSH default when neither the URI nor ssh_config supplies Port. */
export const DEFAULT_SSH_PORT = 22;
export const SSH_SERVE_REMOTE_HOST = "127.0.0.1";
export const SSH_TUNNEL_KEEPALIVE_INTERVAL_S = 15;
export const SSH_TUNNEL_KEEPALIVE_COUNT = 3;
export const SSH_TUNNEL_PORT_RETRIES = 8;
const SSH_STDERR_CAP = 4_096;
const TCP_PROBE_MS = 200;
const SPAWN_RETRY_MS = 50;
const CONTROLLER_ROUTING_FIELDS = ["serveAddress", "local", "ssh"] as const;
const CREDENTIAL_ENV = ["SSH_AUTH_SOCK", "SSH_ASKPASS", "SSH_AGENT_PID"] as const;

/** Short flags that consume the following argv token (or the rest of a cluster). */
const SSH_FLAGS_WITH_ARG = new Set([
  "b",
  "c",
  "D",
  "E",
  "e",
  "F",
  "I",
  "i",
  "J",
  "L",
  "l",
  "m",
  "O",
  "o",
  "p",
  "Q",
  "R",
  "S",
  "W",
  "w",
]);

export type ParsedSshServeTarget = {
  user: string | undefined;
  host: string;
  /** Explicit URI authority port. `undefined` leaves Port to ssh_config / ssh. */
  sshPort: number | undefined;
  servePort: number;
  destination: string;
};

export type SshTunnelArgv = { bin: string; args: string[] };

export type SshTunnelSpawn = (
  bin: string,
  args: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    stdio: ["ignore", "ignore", "pipe"];
    windowsHide: true;
    detached: false;
  },
) => ChildProcess;

export type AcquireServeTunnelOptions = {
  env?: NodeJS.ProcessEnv;
  token?: string;
  timeoutMs: number;
  signal?: AbortSignal;
};

export type ServeTunnelHandle = {
  localTarget: string;
  identity: string;
  hello: ServeHelloData;
  release: () => Promise<void>;
  invalidate: () => Promise<void>;
};

export type ServeTunnelAcquireSuccess = {
  ok: true;
  handle: ServeTunnelHandle;
  localTarget: string;
  hello: ServeHelloData;
};

export type ServeTunnelManager = {
  acquire: (
    raw: string,
    options: AcquireServeTunnelOptions,
  ) => Promise<ServeTunnelAcquireSuccess | OpsResult>;
  /**
   * Terminal disposal: cancels pending acquires, reaps every owned child
   * (including in-flight startups), and rejects later acquires.
   */
  closeAll: () => Promise<void>;
  ownedCount: () => number;
};

export type ServeTunnelManagerOptions = {
  /** MCP keeps idle owned tunnels; CLI tears them down when the last op releases. */
  persistIdle?: boolean;
  spawnSsh?: SshTunnelSpawn;
  allocatePort?: () => Promise<number>;
  probe?: (target: string, options?: ProbeServeOptions) => Promise<OpsResult>;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

type TunnelEntry = {
  key: string;
  identity: string;
  child: ChildProcess;
  localPort: number;
  localTarget: string;
  refs: number;
  stderr: string;
  hello?: ServeHelloData;
  stopping?: Promise<void>;
  retired?: boolean;
};

type AcquireWaiter = {
  signal: AbortSignal;
  deadline: number;
  run: () => Promise<ServeTunnelAcquireSuccess | OpsResult>;
  resolve: (result: ServeTunnelAcquireSuccess | OpsResult) => void;
  settled: boolean;
  timer?: ReturnType<typeof setTimeout>;
  dispose?: () => void;
};

export function isSshServeTarget(raw: string): boolean {
  return /^\s*ssh:\/\//i.test(raw);
}

/**
 * Safe label for logs/errors. Successful parses use the canonical URI.
 * Failed parses omit userinfo, query, path, and fragment so secrets cannot
 * echo through diagnostics.
 */
export function describeServeTarget(raw: string): string {
  const trimmed = raw.trim();
  if (!isSshServeTarget(trimmed)) return trimmed;
  try {
    return formatSshServeTarget(parseSshServeTarget(trimmed));
  } catch {
    return diagnosticSshTarget(trimmed);
  }
}

/** @deprecated Use describeServeTarget; kept for callers that redacted userinfo only. */
export function redactSshUserinfo(raw: string): string {
  return diagnosticSshTarget(raw);
}

export function formatSshServeTarget(target: ParsedSshServeTarget): string {
  const host = target.host.includes(":") ? `[${target.host}]` : target.host;
  const auth = target.user ? `${encodeURIComponent(target.user)}@${host}` : host;
  const port = target.sshPort != null ? `:${target.sshPort}` : "";
  return `ssh://${auth}${port}?servePort=${target.servePort}`;
}

function diagnosticSshTarget(raw: string): string {
  const trimmed = raw.trim();
  if (!isSshServeTarget(trimmed)) return "ssh://";
  try {
    const url = new URL(trimmed);
    if (url.protocol.toLowerCase() !== "ssh:") return "ssh://";
    const host = url.hostname.trim().replace(/^\[|\]$/g, "");
    if (!host || !isSafeDiagnosticHost(host)) return "ssh://";
    const shown = host.includes(":") ? `[${host}]` : host;
    return `ssh://${shown}`;
  } catch {
    return "ssh://";
  }
}

function isSafeDiagnosticHost(host: string): boolean {
  if (!host || host.startsWith("-") || /[\s;|&$<>()?#/%\u0000-\u001f\u007f]/.test(host)) {
    return false;
  }
  return true;
}

function invalid(message: string, raw: string): never {
  throw new ZellijError("bad_arg", `${message} (${diagnosticSshTarget(raw)})`);
}

function rejectSshDestinationPart(value: string, label: string, raw: string): void {
  if (!value) invalid(`ssh:// serve target is missing a ${label}`, raw);
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    invalid("ssh:// serve target contains control characters", raw);
  }
  if (value.startsWith("-") || /^ssh(\s|$)/i.test(value) || /\s/.test(value) || /[;|&$<>()]/.test(value)) {
    invalid("ssh:// destination is not a valid SSH destination", raw);
  }
}

function parsePort(value: string, label: string, raw: string): number {
  if (!/^\d+$/.test(value)) invalid(`ssh:// ${label} is invalid`, raw);
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    invalid(`ssh:// ${label} is invalid`, raw);
  }
  return port;
}

function rejectUnsafeEncoding(raw: string): void {
  if (/[\u0000-\u001f\u007f]/.test(raw)) {
    invalid("ssh:// serve target contains control characters", raw);
  }
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== "%") continue;
    const hex = raw.slice(i + 1, i + 3);
    if (!/^[0-9a-fA-F]{2}$/.test(hex)) {
      invalid("ssh:// serve target contains a malformed escape", raw);
    }
    const code = Number.parseInt(hex, 16);
    if (code <= 0x1f || code === 0x7f) {
      invalid("ssh:// serve target contains control characters", raw);
    }
  }
}

function looksLikePasswordUserinfo(raw: string): boolean {
  const trimmed = raw.trim();
  const rest = trimmed.replace(/^ssh:\/\//i, "");
  const authority = rest.split(/[/?#]/, 1)[0] ?? "";
  const at = authority.lastIndexOf("@");
  if (at <= 0) return false;
  return authority.slice(0, at).includes(":");
}

/**
 * ssh:// is not host:port. Authority port is the SSH port when present; omitting
 * it leaves Port to OpenSSH (alias ssh_config, then ssh's own default).
 * `servePort` is the already-running loopback serve on the remote (default 9419).
 */
export function parseSshServeTarget(raw: string): ParsedSshServeTarget {
  const trimmed = raw.trim();
  if (!isSshServeTarget(trimmed)) {
    invalid("serve ssh target must be an ssh:// URI", trimmed);
  }
  rejectUnsafeEncoding(trimmed);
  if (trimmed.includes("#")) {
    invalid("ssh:// serve target must not include a fragment", trimmed);
  }
  if (looksLikePasswordUserinfo(trimmed) || /\/\/[^/?#]*:[^@/?#]*@/.test(trimmed)) {
    throw new ZellijError(
      "bad_arg",
      "ssh:// serve target must not include a password (redacted)",
    );
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    invalid("ssh:// serve target is not a valid URI", trimmed);
  }
  if (url.protocol.toLowerCase() !== "ssh:") {
    invalid("serve ssh target must be an ssh:// URI", trimmed);
  }
  if (url.password) {
    throw new ZellijError(
      "bad_arg",
      "ssh:// serve target must not include a password (redacted)",
    );
  }
  if (url.hash) {
    invalid("ssh:// serve target must not include a fragment", trimmed);
  }
  const path = url.pathname === "/" || url.pathname === "" ? "" : url.pathname;
  if (path) {
    invalid("ssh:// serve target must not include a path", trimmed);
  }
  const keys = [...url.searchParams.keys()];
  for (const key of keys) {
    if (key !== "servePort") {
      invalid("ssh:// serve target has an unsupported query", trimmed);
    }
  }
  if (url.searchParams.getAll("servePort").length > 1) {
    invalid("ssh:// serve target must not repeat servePort", trimmed);
  }
  const host = url.hostname.trim().replace(/^\[|\]$/g, "");
  rejectSshDestinationPart(host, "host", trimmed);
  const sshPort = url.port ? parsePort(url.port, "SSH port", trimmed) : undefined;
  let servePort = DEFAULT_SSH_SERVE_PORT;
  if (url.searchParams.has("servePort")) {
    servePort = parsePort(
      url.searchParams.get("servePort") ?? "",
      "servePort",
      trimmed,
    );
  }
  let user: string | undefined;
  if (url.username) {
    try {
      user = decodeURIComponent(url.username);
    } catch {
      invalid("ssh:// username is not valid", trimmed);
    }
    if (!user || /[\s;|&$<>()@]/.test(user) || /[\u0000-\u001f\u007f]/.test(user)) {
      invalid("ssh:// username contains invalid characters", trimmed);
    }
    if (user.startsWith("-")) {
      invalid("ssh:// destination is not a valid SSH destination", trimmed);
    }
  }
  const destination = user ? `${user}@${host}` : host;
  rejectSshDestinationPart(destination.includes("@") ? host : destination, "host", trimmed);
  if (destination.startsWith("-")) {
    invalid("ssh:// destination is not a valid SSH destination", trimmed);
  }
  return { user, host, sshPort, servePort, destination };
}

function parseOptionKeyword(raw: string): { name: string; value: string } {
  const trimmed = raw.trim();
  const sep = trimmed.search(/[=\s]/);
  if (sep === -1) return { name: trimmed.toLowerCase(), value: "" };
  return {
    name: trimmed.slice(0, sep).trim().toLowerCase(),
    value: trimmed.slice(sep + 1).trim().toLowerCase(),
  };
}

function sshOptionAt(
  opts: string[],
  index: number,
): { name: string; value: string; consumed: number } | null {
  const arg = opts[index]!;
  let raw = "";
  let consumed = 0;
  if (arg === "-o") {
    raw = opts[index + 1] ?? "";
    consumed = 2;
  } else if (arg.startsWith("-o") && arg.length > 2) {
    raw = arg.slice(2);
    consumed = 1;
  } else {
    return null;
  }
  const parsed = parseOptionKeyword(raw);
  return { name: parsed.name, value: parsed.value, consumed };
}

function isDisabled(value: string): boolean {
  return value === "" || value === "no" || value === "off" || value === "false" || value === "0";
}

function rejectForbiddenKeyword(name: string, value: string): void {
  if (name === "controlmaster" && !isDisabled(value)) {
    throw new ZellijError(
      "bad_ssh",
      `ZSWARM_SSH_OPTS ControlMaster=${value || "yes"} would outlive the tracked ssh child; zswarm uses a foreground-owned tunnel`,
    );
  }
  if (name === "controlpersist" && !isDisabled(value)) {
    throw new ZellijError(
      "bad_ssh",
      `ZSWARM_SSH_OPTS ControlPersist=${value || "yes"} would outlive the tracked ssh child`,
    );
  }
  if (name === "controlpath" && value !== "" && value !== "none") {
    throw new ZellijError(
      "bad_ssh",
      "ZSWARM_SSH_OPTS must not set ControlPath; zswarm uses ControlPath=none for a private foreground child",
    );
  }
  if (name === "forkafterauthentication" && !isDisabled(value)) {
    throw new ZellijError("bad_ssh", "ZSWARM_SSH_OPTS must not fork the ssh child");
  }
  if (name === "exitonforwardfailure" && isDisabled(value) && value !== "") {
    throw new ZellijError("bad_ssh", "ZSWARM_SSH_OPTS must not disable ExitOnForwardFailure");
  }
  if (name === "batchmode" && isDisabled(value) && value !== "") {
    throw new ZellijError(
      "bad_ssh",
      "ZSWARM_SSH_OPTS must not disable BatchMode; ssh:// tunnels are noninteractive",
    );
  }
  if (
    name === "remotecommand" ||
    name === "localcommand" ||
    name === "permitlocalcommand" ||
    name === "localforward" ||
    name === "remoteforward" ||
    name === "dynamicforward"
  ) {
    throw new ZellijError(
      "bad_ssh",
      `ZSWARM_SSH_OPTS ${name} is incompatible with a process-owned LocalForward`,
    );
  }
}

function rejectFlagLetter(flag: string): void {
  if (flag === "f") {
    throw new ZellijError(
      "bad_ssh",
      "ZSWARM_SSH_OPTS must not daemonize ssh (-f); zswarm owns a foreground LocalForward child",
    );
  }
  if (flag === "M") {
    throw new ZellijError(
      "bad_ssh",
      "ZSWARM_SSH_OPTS must not enable ControlMaster (-M); zswarm uses a foreground-owned tunnel",
    );
  }
  if (flag === "L" || flag === "R" || flag === "D") {
    throw new ZellijError("bad_ssh", "ZSWARM_SSH_OPTS must not add extra forwards; zswarm owns -L");
  }
  if (flag === "p") {
    throw new ZellijError(
      "bad_ssh",
      "ZSWARM_SSH_OPTS must not set -p; put an explicit SSH port on the ssh:// URI or in ssh_config",
    );
  }
  if (flag === "W" || flag === "O" || flag === "t" || flag === "V" || flag === "G" || flag === "s") {
    throw new ZellijError(
      "bad_ssh",
      `ZSWARM_SSH_OPTS contains ssh flag -${flag}, which is incompatible with a process-owned LocalForward`,
    );
  }
}

/**
 * Reject ControlMaster/daemonize/fork/extra forwards/remote commands that would
 * outlive or escape the tracked foreground child. Combined clusters (`-fn`) and
 * whitespace `-o Keyword Value` forms are parsed, not only `-o Keyword=value`.
 */
export function assertSafeSshTunnelOpts(opts: string[]): void {
  for (let i = 0; i < opts.length; i++) {
    const arg = opts[i]!;
    if (arg === "--" || arg.startsWith("--")) {
      throw new ZellijError(
        "bad_ssh",
        "ZSWARM_SSH_OPTS must not include a destination or remote command",
      );
    }
    if (arg === "-" || !arg.startsWith("-")) {
      throw new ZellijError(
        "bad_ssh",
        "ZSWARM_SSH_OPTS must not include a destination or remote command",
      );
    }
    const option = sshOptionAt(opts, i);
    if (option) {
      rejectForbiddenKeyword(option.name, option.value);
      i += option.consumed - 1;
      continue;
    }
    if (arg === "-S" || arg.startsWith("-S")) {
      const value = arg === "-S" ? (opts[++i] ?? "") : arg.slice(2);
      if (value.trim().toLowerCase() !== "none") {
        throw new ZellijError(
          "bad_ssh",
          "ZSWARM_SSH_OPTS must not set ControlPath; zswarm uses -S none",
        );
      }
      continue;
    }
    if (arg.length === 2) {
      const flag = arg[1]!;
      rejectFlagLetter(flag);
      if (SSH_FLAGS_WITH_ARG.has(flag)) {
        if (opts[i + 1] === undefined) {
          throw new ZellijError("bad_ssh", `ZSWARM_SSH_OPTS ${arg} is missing an argument`);
        }
        i += 1;
      }
      continue;
    }
    // Combined short flags, e.g. -fn / -NTf, or attached-arg forms like -iKEY.
    // Argument-taking flags consume the rest of the cluster or the next argv
    // token and validate -o keywords (so -voLocalForward=… cannot skip the guard).
    let j = 1;
    while (j < arg.length) {
      const flag = arg[j]!;
      rejectFlagLetter(flag);
      if (SSH_FLAGS_WITH_ARG.has(flag)) {
        let value: string;
        if (j + 1 < arg.length) {
          value = arg.slice(j + 1);
        } else if (opts[i + 1] === undefined) {
          throw new ZellijError("bad_ssh", `ZSWARM_SSH_OPTS -${flag} is missing an argument`);
        } else {
          value = opts[++i]!;
        }
        if (flag === "o") {
          const parsed = parseOptionKeyword(value);
          rejectForbiddenKeyword(parsed.name, parsed.value);
        } else if (flag === "S" && value.trim().toLowerCase() !== "none") {
          throw new ZellijError(
            "bad_ssh",
            "ZSWARM_SSH_OPTS must not set ControlPath; zswarm uses -S none",
          );
        }
        break;
      }
      j += 1;
    }
  }
}

/**
 * Required `-o` keywords come first so OpenSSH's first-obtained-value rule
 * cannot be overridden by later user `-o` or ssh_config. `-S none` is last so
 * a last-assignment ControlPath flag still loses. Explicit URI `-p` is emitted
 * only when the URI supplied a port; omitted port leaves alias Port intact.
 */
export function buildSshTunnelArgv(
  target: ParsedSshServeTarget,
  localPort: number,
  env: NodeJS.ProcessEnv = {},
): SshTunnelArgv {
  const bin = env.ZSWARM_SSH_BIN?.trim() || "ssh";
  const userOpts = parseSshOpts(env.ZSWARM_SSH_OPTS ?? "");
  assertSafeSshTunnelOpts(userOpts);
  const args = [
    "-N",
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    `ServerAliveInterval=${SSH_TUNNEL_KEEPALIVE_INTERVAL_S}`,
    "-o",
    `ServerAliveCountMax=${SSH_TUNNEL_KEEPALIVE_COUNT}`,
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPath=none",
    "-o",
    "ControlPersist=no",
    "-o",
    "ForkAfterAuthentication=no",
    ...userOpts,
    "-S",
    "none",
    "-N",
    "-T",
    "-o",
    "ForkAfterAuthentication=no",
    "-L",
    `${SSH_SERVE_REMOTE_HOST}:${localPort}:${SSH_SERVE_REMOTE_HOST}:${target.servePort}`,
  ];
  if (target.sshPort != null) {
    args.push("-p", String(target.sshPort));
  }
  args.push(target.destination);
  return { bin, args };
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function credentialFingerprints(env: NodeJS.ProcessEnv): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const name of CREDENTIAL_ENV) {
    const raw = env[name];
    out[name] = raw == null ? null : fingerprint(raw);
  }
  return out;
}

/** Isolated identity for an owned tunnel. Never includes the serve token or raw secrets. */
export function serveTunnelCacheKey(
  target: ParsedSshServeTarget,
  env: NodeJS.ProcessEnv = {},
): string {
  return JSON.stringify({
    bin: env.ZSWARM_SSH_BIN?.trim() || "ssh",
    opts: fingerprint(JSON.stringify(parseSshOpts(env.ZSWARM_SSH_OPTS ?? ""))),
    destination: target.destination,
    sshPort: target.sshPort ?? null,
    serveHost: SSH_SERVE_REMOTE_HOST,
    servePort: target.servePort,
    credentials: credentialFingerprints(env),
  });
}

export function allocateLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, SSH_SERVE_REMOTE_HOST, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      server.close((err) => {
        if (err) reject(err);
        else if (!Number.isInteger(port) || port < 1) {
          reject(new ZellijError("failed", "failed to allocate a private loopback port"));
        } else resolve(port);
      });
    });
  });
}

function childAlive(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ZellijError("cancelled", "operation cancelled"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ZellijError("cancelled", "operation cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function waitForTcp(
  port: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted || timeoutMs <= 0) {
      resolve(false);
      return;
    }
    const socket = connect({ host: SSH_SERVE_REMOTE_HOST, port });
    const timer = setTimeout(() => finish(false), Math.max(1, timeoutMs));
    const finish = (ok: boolean) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    const onAbort = () => finish(false);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isLocalBindFailure(stderr: string): boolean {
  return /address already in use|eaddrinuse|cannot listen|failed to bind|error: bind/i.test(
    stderr,
  );
}

function sshSpawnEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...process.env, ...env };
  delete out.ZSWARM_SERVE_TOKEN;
  return out;
}

function redactText(text: string, token?: string): string {
  const secret = token?.trim();
  if (!secret) return text;
  return text.split(secret).join("***");
}

function cancelledResult(): OpsResult {
  return { ok: false, error: { code: "cancelled", message: "operation cancelled" } };
}

function closedResult(): OpsResult {
  return {
    ok: false,
    error: { code: "cancelled", message: "serve tunnel manager is closed" },
  };
}

function timeoutResult(message = "operation timed out"): OpsResult {
  return { ok: false, error: { code: "timeout", message } };
}

function isFinalProbeFailure(result: OpsResult): boolean {
  if (result.ok) return false;
  const code = result.error.code;
  return (
    code === "serve_unauthorized" ||
    code === "serve_incompatible" ||
    code === "serve_hello_unsupported" ||
    (code === "serve_protocol" &&
      (result.error.details as { delivery?: string } | undefined)?.delivery === "replied")
  );
}

function isAcquireSuccess(
  result: ServeTunnelAcquireSuccess | OpsResult,
): result is ServeTunnelAcquireSuccess {
  return result.ok === true && "handle" in result && "localTarget" in result;
}

function isNotSentConnectFailure(result: OpsResult): boolean {
  if (result.ok) return false;
  const details = result.error.details as
    | { delivery?: string; phase?: string }
    | undefined;
  if (details?.delivery && details.delivery !== "not_sent") return false;
  if (result.error.code === "serve_unreachable") return true;
  return result.error.code === "timeout" && details?.phase === "connect";
}

function asHello(data: unknown): ServeHelloData | undefined {
  if (!data || typeof data !== "object") return undefined;
  const d = data as Record<string, unknown>;
  if (
    typeof d.protocol !== "number" ||
    typeof d.serverId !== "string" ||
    typeof d.hostname !== "string" ||
    typeof d.platform !== "string" ||
    typeof d.version !== "string" ||
    !Array.isArray(d.capabilities)
  ) {
    return undefined;
  }
  return {
    protocol: d.protocol,
    serverId: d.serverId,
    hostname: d.hostname,
    platform: d.platform,
    version: d.version,
    capabilities: d.capabilities.filter((cap): cap is string => typeof cap === "string"),
  };
}

function mergeSignals(...signals: Array<AbortSignal | undefined>): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const ac = new AbortController();
  const abort = () => ac.abort();
  const attached: AbortSignal[] = [];
  const dispose = () => {
    for (const signal of attached) signal.removeEventListener("abort", abort);
    attached.length = 0;
  };
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      ac.abort();
      dispose();
      return { signal: ac.signal, dispose: () => undefined };
    }
    signal.addEventListener("abort", abort, { once: true });
    attached.push(signal);
  }
  return { signal: ac.signal, dispose };
}

const defaultSpawn: SshTunnelSpawn = (bin, args, options) => {
  const trimmed = bin.trim() || "ssh";
  if (/\.(mjs|cjs|js)$/i.test(trimmed)) {
    return spawn(process.execPath, [trimmed, ...args], options);
  }
  return spawn(trimmed, args, options);
};

function stopChild(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (!childAlive(child)) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, 1_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      child.kill("SIGTERM");
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

export function stripControllerRouting(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const request = { ...args };
  for (const field of CONTROLLER_ROUTING_FIELDS) delete request[field];
  return request;
}

export function createServeTunnelManager(
  options: ServeTunnelManagerOptions = {},
): ServeTunnelManager {
  const persistIdle = options.persistIdle === true;
  const spawnSsh = options.spawnSsh ?? defaultSpawn;
  const allocatePort = options.allocatePort ?? allocateLoopbackPort;
  const probe = options.probe ?? probeServe;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const adoptable = new Map<string, TunnelEntry>();
  const owned = new Set<TunnelEntry>();
  const queues = new Map<string, AcquireWaiter[]>();
  const running = new Set<string>();
  const pending = new Set<Promise<unknown>>();
  const inflight = new Set<Promise<unknown>>();
  const closeAbort = new AbortController();
  let closed = false;

  const remaining = (deadline: number): number => Math.max(0, deadline - now());

  const stopEntry = async (entry: TunnelEntry): Promise<void> => {
    if (entry.stopping) {
      await entry.stopping;
      return;
    }
    entry.retired = true;
    if (adoptable.get(entry.key) === entry) adoptable.delete(entry.key);
    entry.stopping = stopChild(entry.child).finally(() => {
      owned.delete(entry);
    });
    await entry.stopping;
  };

  const makeHandle = (entry: TunnelEntry, hello: ServeHelloData): ServeTunnelHandle => {
    let released = false;
    return {
      localTarget: entry.localTarget,
      identity: entry.identity,
      hello,
      release: async () => {
        if (released) return;
        released = true;
        entry.refs = Math.max(0, entry.refs - 1);
        if (entry.refs === 0 && (!persistIdle || entry.retired || closed)) {
          await stopEntry(entry);
        }
      },
      invalidate: async () => {
        if (!released) {
          released = true;
          entry.refs = Math.max(0, entry.refs - 1);
        }
        entry.retired = true;
        if (adoptable.get(entry.key) === entry) adoptable.delete(entry.key);
        if (entry.refs === 0) await stopEntry(entry);
      },
    };
  };

  const adopt = (entry: TunnelEntry, hello: ServeHelloData): ServeTunnelAcquireSuccess => {
    entry.refs += 1;
    entry.hello = hello;
    return {
      ok: true,
      handle: makeHandle(entry, hello),
      localTarget: entry.localTarget,
      hello,
    };
  };

  const spawnOwned = async (
    target: ParsedSshServeTarget,
    env: NodeJS.ProcessEnv,
    token: string | undefined,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<TunnelEntry> => {
    let lastError = "ssh LocalForward did not start";
    for (let attempt = 0; attempt < SSH_TUNNEL_PORT_RETRIES; attempt++) {
      if (closed) throw new ZellijError("cancelled", "serve tunnel manager is closed");
      if (signal?.aborted) throw new ZellijError("cancelled", "operation cancelled");
      if (remaining(deadline) <= 0) {
        throw new ZellijError(
          "timeout",
          `ssh LocalForward timed out (${formatSshServeTarget(target)})`,
        );
      }
      const localPort = await allocatePort();
      if (closed || signal?.aborted || remaining(deadline) <= 0) {
        if (signal?.aborted) throw new ZellijError("cancelled", "operation cancelled");
        if (closed) throw new ZellijError("cancelled", "serve tunnel manager is closed");
        throw new ZellijError(
          "timeout",
          `ssh LocalForward timed out (${formatSshServeTarget(target)})`,
        );
      }
      if (await waitForTcp(localPort, 50, signal)) {
        lastError = `loopback port ${localPort} is already in use`;
        continue;
      }
      const argv = buildSshTunnelArgv(target, localPort, env);
      const child = spawnSsh(argv.bin, argv.args, {
        env: sshSpawnEnv(env),
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
        detached: false,
      });
      const entry: TunnelEntry = {
        key: serveTunnelCacheKey(target, env),
        identity: formatSshServeTarget(target),
        child,
        localPort,
        localTarget: formatListenLabel(SSH_SERVE_REMOTE_HOST, localPort),
        refs: 0,
        stderr: "",
      };
      owned.add(entry);
      if (closed || signal?.aborted || remaining(deadline) <= 0) {
        await stopEntry(entry);
        if (closed) throw new ZellijError("cancelled", "serve tunnel manager is closed");
        if (signal?.aborted) throw new ZellijError("cancelled", "operation cancelled");
        throw new ZellijError(
          "timeout",
          `ssh LocalForward timed out (${formatSshServeTarget(target)})`,
        );
      }
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        entry.stderr = redactText(`${entry.stderr}${chunk}`, token).slice(-SSH_STDERR_CAP);
      });
      child.on("error", (err) => {
        const code = (err as { code?: string }).code;
        entry.stderr = redactText(
          `${entry.stderr}${code ? `${code}: ` : ""}${err.message} (bin=${argv.bin})`,
          token,
        ).slice(-SSH_STDERR_CAP);
        try {
          child.kill("SIGTERM");
        } catch {
          /* spawn never started */
        }
      });
      child.on("exit", () => {
        owned.delete(entry);
        if (adoptable.get(entry.key) === entry) adoptable.delete(entry.key);
      });

      const started = now();
      while (childAlive(child) && remaining(deadline) > 0 && !signal?.aborted && !closed) {
        const ok = await waitForTcp(
          localPort,
          Math.min(TCP_PROBE_MS, remaining(deadline)),
          signal,
        );
        if (ok) {
          await sleep(Math.min(30, remaining(deadline) || 30), signal).catch(() => undefined);
          if (childAlive(child) && !closed && !signal?.aborted) return entry;
          break;
        }
        await sleep(Math.min(SPAWN_RETRY_MS, remaining(deadline) || SPAWN_RETRY_MS), signal).catch(
          () => undefined,
        );
      }
      const stderr = entry.stderr.trim();
      lastError =
        redactText(stderr, token) ||
        (child.exitCode == null
          ? `ssh LocalForward to ${entry.identity} did not become reachable`
          : `ssh LocalForward to ${entry.identity} exited (${child.exitCode})`);
      await stopEntry(entry);
      if (closed) throw new ZellijError("cancelled", "serve tunnel manager is closed");
      if (signal?.aborted) throw new ZellijError("cancelled", "operation cancelled");
      if (!isLocalBindFailure(stderr) && child.exitCode !== 0 && now() - started < 400) {
        if (stderr && !isLocalBindFailure(stderr)) {
          throw new ZellijError(
            "serve_unreachable",
            `cannot start ssh LocalForward to ${entry.identity}: ${lastError}`,
          );
        }
      }
    }
    throw new ZellijError(
      "serve_unreachable",
      `cannot start ssh LocalForward (${redactText(lastError, token)})`,
    );
  };

  const probeReady = async (
    entry: TunnelEntry,
    token: string | undefined,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<OpsResult> => {
    let last: OpsResult | undefined;
    while (childAlive(entry.child) && remaining(deadline) > 0 && !signal?.aborted && !closed) {
      const budget = Math.min(2_000, remaining(deadline));
      if (budget <= 0) break;
      const result = await probe(entry.localTarget, {
        token,
        timeoutMs: budget,
        signal,
      });
      last = result;
      if (result.ok) return result;
      if (isFinalProbeFailure(result)) return result;
      await sleep(Math.min(SPAWN_RETRY_MS, remaining(deadline) || SPAWN_RETRY_MS), signal).catch(
        () => undefined,
      );
    }
    if (closed) return closedResult();
    if (signal?.aborted) return cancelledResult();
    if (!childAlive(entry.child)) {
      return {
        ok: false,
        error: {
          code: "serve_unreachable",
          message: `ssh LocalForward to ${entry.identity} closed before serve hello`,
        },
      };
    }
    return (
      last ?? {
        ok: false,
        error: {
          code: "timeout",
          message: `ssh LocalForward to ${entry.identity} timed out waiting for serve hello`,
        },
      }
    );
  };

  const liveAdoptable = (key: string): TunnelEntry | undefined => {
    const existing = adoptable.get(key);
    if (!existing || !childAlive(existing.child) || existing.stopping || existing.retired) {
      return undefined;
    }
    return existing;
  };

  const acquireOne = async (
    target: ParsedSshServeTarget,
    env: NodeJS.ProcessEnv,
    token: string | undefined,
    deadline: number,
    signal: AbortSignal,
  ): Promise<ServeTunnelAcquireSuccess | OpsResult> => {
    const key = serveTunnelCacheKey(target, env);
    const failIfStale = (): OpsResult | undefined => {
      if (closed) return closedResult();
      if (signal.aborted) return cancelledResult();
      if (remaining(deadline) <= 0) {
        return timeoutResult(`ssh LocalForward timed out (${formatSshServeTarget(target)})`);
      }
      return undefined;
    };
    const stale = failIfStale();
    if (stale) return stale;

    const existing = liveAdoptable(key);
    if (existing) {
      const probed = await probeReady(existing, token, deadline, signal);
      const afterProbe = failIfStale();
      if (afterProbe) return afterProbe;
      if (!probed.ok) return probed;
      const hello = asHello(probed.data);
      if (!hello) {
        return {
          ok: false,
          error: {
            code: "serve_protocol",
            message: `ssh LocalForward to ${existing.identity} returned an invalid hello`,
          },
        };
      }
      const beforeAdopt = failIfStale();
      if (beforeAdopt) return beforeAdopt;
      if (!liveAdoptable(key) || liveAdoptable(key) !== existing) {
        return (
          failIfStale() ?? {
            ok: false,
            error: {
              code: "serve_unreachable",
              message: `ssh LocalForward to ${existing.identity} closed before serve hello`,
            },
          }
        );
      }
      return adopt(existing, hello);
    }

    const previous = adoptable.get(key);
    if (previous) await stopEntry(previous);
    const started = failIfStale();
    if (started) return started;

    const entry = await spawnOwned(target, env, token, deadline, signal);
    try {
      const afterSpawn = failIfStale();
      if (afterSpawn) {
        await stopEntry(entry);
        return afterSpawn;
      }
      const probed = await probeReady(entry, token, deadline, signal);
      const afterProbe = failIfStale();
      if (afterProbe) {
        await stopEntry(entry);
        return afterProbe;
      }
      if (!probed.ok) {
        await stopEntry(entry);
        return probed;
      }
      const hello = asHello(probed.data);
      if (!hello) {
        await stopEntry(entry);
        return {
          ok: false,
          error: {
            code: "serve_protocol",
            message: `ssh LocalForward to ${entry.identity} returned an invalid hello`,
          },
        };
      }
      if (closed || signal.aborted || remaining(deadline) <= 0) {
        await stopEntry(entry);
        return failIfStale() ?? closedResult();
      }
      adoptable.set(key, entry);
      return adopt(entry, hello);
    } catch (err) {
      await stopEntry(entry);
      throw err;
    }
  };

  const pruneQueue = (key: string): void => {
    const remainingWaiters = (queues.get(key) ?? []).filter((waiter) => !waiter.settled);
    if (remainingWaiters.length === 0) queues.delete(key);
    else queues.set(key, remainingWaiters);
  };

  const detachWaiter = (waiter: AcquireWaiter): void => {
    if (waiter.timer) {
      clearTimeout(waiter.timer);
      waiter.timer = undefined;
    }
    waiter.dispose?.();
    waiter.dispose = undefined;
  };

  const publishWaiter = (
    waiter: AcquireWaiter,
    result: ServeTunnelAcquireSuccess | OpsResult,
  ): boolean => {
    if (waiter.settled) {
      if (isAcquireSuccess(result)) void result.handle.release();
      return false;
    }
    waiter.settled = true;
    if (waiter.timer) {
      clearTimeout(waiter.timer);
      waiter.timer = undefined;
    }
    waiter.resolve(result);
    return true;
  };

  const settleWaiter = (
    waiter: AcquireWaiter,
    result: ServeTunnelAcquireSuccess | OpsResult,
  ): void => {
    if (!publishWaiter(waiter, result)) return;
    detachWaiter(waiter);
  };

  const pump = (key: string): void => {
    if (running.has(key)) return;
    const queue = queues.get(key) ?? [];
    const next = queue.find((waiter) => !waiter.settled);
    if (!next) {
      pruneQueue(key);
      return;
    }
    running.add(key);
    if (next.timer) {
      clearTimeout(next.timer);
      next.timer = undefined;
    }
    const job = (async () => {
      try {
        if (next.settled) return;
        if (closed) {
          settleWaiter(next, closedResult());
          return;
        }
        if (next.signal.aborted) {
          settleWaiter(next, cancelledResult());
          return;
        }
        if (remaining(next.deadline) <= 0) {
          settleWaiter(
            next,
            timeoutResult("ssh LocalForward timed out waiting for an owned tunnel"),
          );
          return;
        }
        const result = await next.run();
        if (next.settled) {
          if (isAcquireSuccess(result)) await result.handle.release();
          return;
        }
        settleWaiter(next, result);
      } catch (err) {
        settleWaiter(next, fail(err));
      } finally {
        running.delete(key);
        pruneQueue(key);
        pump(key);
      }
    })();
    inflight.add(job);
    void job.finally(() => inflight.delete(job));
  };

  const enqueue = (
    key: string,
    waiter: AcquireWaiter,
    deadlineAbort: AbortController,
  ): Promise<ServeTunnelAcquireSuccess | OpsResult> => {
    const promise = new Promise<ServeTunnelAcquireSuccess | OpsResult>((resolve) => {
      waiter.resolve = resolve;
    });
    const queue = queues.get(key) ?? [];
    queue.push(waiter);
    queues.set(key, queue);
    const finishEarly = (result: OpsResult) => {
      // Publish the public result first so a forwarded abort cannot overwrite
      // timeout with cancelled. Abort in-flight work while merge listeners are
      // still attached, then detach so caller signals do not retain waiters.
      if (!publishWaiter(waiter, result)) return;
      deadlineAbort.abort();
      detachWaiter(waiter);
      pruneQueue(key);
      if (!running.has(key)) pump(key);
    };
    const onCallerAbort = () => {
      if (waiter.settled) return;
      finishEarly(closed ? closedResult() : cancelledResult());
    };
    const onTimeout = () => {
      if (waiter.settled) return;
      finishEarly(
        closed
          ? closedResult()
          : timeoutResult("ssh LocalForward timed out waiting for an owned tunnel"),
      );
    };
    if (closed) {
      finishEarly(closedResult());
      return promise;
    }
    if (remaining(waiter.deadline) <= 0) {
      finishEarly(timeoutResult("ssh LocalForward timed out waiting for an owned tunnel"));
      return promise;
    }
    if (waiter.signal.aborted) {
      finishEarly(cancelledResult());
      return promise;
    }
    waiter.signal.addEventListener("abort", onCallerAbort, { once: true });
    const previousDispose = waiter.dispose;
    waiter.dispose = () => {
      waiter.signal.removeEventListener("abort", onCallerAbort);
      previousDispose?.();
    };
    waiter.timer = setTimeout(onTimeout, Math.max(1, remaining(waiter.deadline)));
    pump(key);
    return promise;
  };

  const acquire: ServeTunnelManager["acquire"] = (raw, opts) => {
    const env = opts.env ?? {};
    const target = parseSshServeTarget(raw);
    const key = serveTunnelCacheKey(target, env);
    const deadline = now() + Math.max(1, opts.timeoutMs);
    const deadlineAbort = new AbortController();
    const merged = mergeSignals(opts.signal, closeAbort.signal, deadlineAbort.signal);
    const work = (): Promise<ServeTunnelAcquireSuccess | OpsResult> =>
      acquireOne(target, env, opts.token, deadline, merged.signal);
    if (closed) {
      merged.dispose();
      return Promise.resolve(closedResult());
    }
    const waiter: AcquireWaiter = {
      signal: merged.signal,
      deadline,
      run: work,
      resolve: () => undefined,
      settled: false,
      dispose: merged.dispose,
    };
    const tracked = enqueue(key, waiter, deadlineAbort);
    pending.add(tracked);
    void tracked.finally(() => pending.delete(tracked));
    return tracked;
  };

  return {
    acquire,
    closeAll: async () => {
      if (!closed) {
        closed = true;
        closeAbort.abort();
      }
      for (const queue of queues.values()) {
        for (const waiter of queue) {
          settleWaiter(waiter, closedResult());
        }
      }
      queues.clear();
      const entries = [...owned];
      adoptable.clear();
      await Promise.all(entries.map((entry) => stopEntry(entry)));
      await Promise.allSettled([...inflight, ...pending]);
    },
    ownedCount: () => {
      let n = 0;
      for (const entry of owned) {
        if (childAlive(entry.child) && !entry.stopping) n += 1;
      }
      return n;
    },
  };
}

export async function forwardServe(input: {
  target: string;
  args: Record<string, unknown>;
  timeoutMs: number;
  token?: string;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  manager?: ServeTunnelManager;
  now?: () => number;
}): Promise<OpsResult> {
  const target = input.target.trim();
  const timeoutMs = Math.max(1, input.timeoutMs);
  const request = stripControllerRouting(input.args);
  if (!isSshServeTarget(target)) {
    return callServe(target, request, timeoutMs, input.token, input.signal);
  }
  const owned = input.manager;
  const manager = owned ?? createServeTunnelManager({ persistIdle: false, now: input.now });
  const clock = input.now ?? Date.now;
  const deadline = clock() + timeoutMs;
  const remaining = (): number => Math.max(0, deadline - clock());
  const acquireOpts = (): AcquireServeTunnelOptions => ({
    env: input.env,
    token: input.token,
    timeoutMs: remaining(),
    signal: input.signal,
  });
  try {
    if (input.signal?.aborted) return cancelledResult();
    if (remaining() <= 0) return timeoutResult();
    const first = await manager.acquire(target, acquireOpts());
    if (!isAcquireSuccess(first)) return first;
    try {
      const budget = remaining();
      if (input.signal?.aborted) return cancelledResult();
      if (budget <= 0) return timeoutResult();
      let result = await callServe(
        first.localTarget,
        request,
        budget,
        input.token,
        input.signal,
      );
      if (isNotSentConnectFailure(result) && remaining() > 0 && !input.signal?.aborted) {
        await first.handle.invalidate();
        if (remaining() <= 0 || input.signal?.aborted) {
          return input.signal?.aborted ? cancelledResult() : timeoutResult();
        }
        const again = await manager.acquire(target, acquireOpts());
        if (!isAcquireSuccess(again)) return again;
        try {
          const retryBudget = remaining();
          if (input.signal?.aborted) return cancelledResult();
          if (retryBudget <= 0) return timeoutResult();
          result = await callServe(
            again.localTarget,
            request,
            retryBudget,
            input.token,
            input.signal,
          );
        } finally {
          await again.handle.release();
        }
      }
      return result;
    } finally {
      await first.handle.release();
    }
  } finally {
    if (!owned) await manager.closeAll();
  }
}
