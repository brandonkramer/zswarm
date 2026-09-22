import { spawn, type ChildProcess } from "node:child_process";
import { connect, createServer } from "node:net";
import { ZellijError } from "../errors.js";
import { parseSshOpts } from "../zellij/binary.js";
import {
  callServe,
  formatListenLabel,
  parseListenAddress,
  probeServe,
  type ProbeServeOptions,
} from "./serve.js";
import type { OpsResult } from "./types.js";

export const DEFAULT_SSH_SERVE_PORT = parseListenAddress(undefined).port;
export const DEFAULT_SSH_PORT = 22;
export const SSH_SERVE_REMOTE_HOST = "127.0.0.1";
export const SSH_TUNNEL_KEEPALIVE_INTERVAL_S = 15;
export const SSH_TUNNEL_KEEPALIVE_COUNT = 3;
export const SSH_TUNNEL_PORT_RETRIES = 8;
const SSH_STDERR_CAP = 4_096;
const TCP_PROBE_MS = 200;
const SPAWN_RETRY_MS = 50;
const CONTROLLER_ROUTING_FIELDS = ["serveAddress", "local", "ssh"] as const;

export type ParsedSshServeTarget = {
  user: string | undefined;
  host: string;
  sshPort: number;
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
  release: () => Promise<void>;
  invalidate: () => Promise<void>;
};

export type ServeTunnelAcquireSuccess = {
  ok: true;
  handle: ServeTunnelHandle;
  localTarget: string;
};

export type ServeTunnelManager = {
  acquire: (
    raw: string,
    options: AcquireServeTunnelOptions,
  ) => Promise<ServeTunnelAcquireSuccess | OpsResult>;
  closeAll: () => Promise<void>;
  ownedCount: () => number;
};

export type ServeTunnelManagerOptions = {
  /** MCP keeps idle owned tunnels; CLI tears them down when the last op releases. */
  persistIdle?: boolean;
  spawnSsh?: SshTunnelSpawn;
  allocatePort?: () => Promise<number>;
  probe?: (target: string, options?: ProbeServeOptions) => Promise<OpsResult>;
};

type TunnelEntry = {
  key: string;
  identity: string;
  child: ChildProcess;
  localPort: number;
  localTarget: string;
  refs: number;
  stderr: string;
  stopping?: Promise<void>;
};

export function isSshServeTarget(raw: string): boolean {
  return /^\s*ssh:\/\//i.test(raw);
}

/** Strip userinfo passwords so parse/spawn errors never echo secrets. */
export function redactSshUserinfo(raw: string): string {
  return raw.replace(/(ssh:\/\/[^/@?#\s]+):([^@/?#]*)@/gi, "$1:***@");
}

export function formatSshServeTarget(target: ParsedSshServeTarget): string {
  const host = target.host.includes(":") ? `[${target.host}]` : target.host;
  const auth = target.user ? `${encodeURIComponent(target.user)}@${host}` : host;
  return `ssh://${auth}:${target.sshPort}?servePort=${target.servePort}`;
}

export function describeServeTarget(raw: string): string {
  const trimmed = raw.trim();
  if (!isSshServeTarget(trimmed)) return trimmed;
  try {
    return formatSshServeTarget(parseSshServeTarget(trimmed));
  } catch {
    return redactSshUserinfo(trimmed);
  }
}

function invalid(message: string, raw: string): never {
  throw new ZellijError("bad_arg", `${message} (${redactSshUserinfo(raw)})`);
}

function rejectHost(host: string, raw: string): void {
  if (!host) invalid("ssh:// serve target is missing a host", raw);
  if (/^ssh(\s|$)/i.test(host) || host.startsWith("-") || /\s/.test(host) || /[;|&$<>()]/.test(host)) {
    invalid("ssh:// host is not a valid SSH destination", raw);
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

/**
 * ssh:// is not host:port. Authority port is the SSH port (default 22).
 * `servePort` is the already-running loopback serve on the remote (default 9419).
 */
export function parseSshServeTarget(raw: string): ParsedSshServeTarget {
  const trimmed = raw.trim();
  if (!isSshServeTarget(trimmed)) {
    invalid("serve ssh target must be an ssh:// URI", trimmed);
  }
  if (trimmed.includes("#")) {
    invalid("ssh:// serve target must not include a fragment", trimmed);
  }
  if (/\/\/[^/?#]*:[^@/?#]*@/.test(trimmed)) {
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
      invalid(`ssh:// serve target has unknown query (${key || "empty"})`, trimmed);
    }
  }
  if (url.searchParams.getAll("servePort").length > 1) {
    invalid("ssh:// serve target must not repeat servePort", trimmed);
  }
  const host = url.hostname.trim();
  rejectHost(host, trimmed);
  const sshPort = url.port
    ? parsePort(url.port, "SSH port", trimmed)
    : DEFAULT_SSH_PORT;
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
    if (!user || /[\s;|&$<>()]/.test(user)) {
      invalid("ssh:// username contains invalid characters", trimmed);
    }
  }
  const destination = user ? `${user}@${host}` : host;
  rejectHost(destination.includes("@") ? host : destination, trimmed);
  return { user, host, sshPort, servePort, destination };
}

function sshOptionAt(opts: string[], index: number): { name: string; value: string; consumed: number } | null {
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
  const eq = raw.indexOf("=");
  const name = (eq === -1 ? raw : raw.slice(0, eq)).trim().toLowerCase();
  const value = (eq === -1 ? "" : raw.slice(eq + 1)).trim().toLowerCase();
  return { name, value, consumed };
}

function isDisabled(value: string): boolean {
  return value === "" || value === "no" || value === "off" || value === "false" || value === "0";
}

/** Reject ControlMaster/daemonize that would outlive the tracked foreground child. */
export function assertSafeSshTunnelOpts(opts: string[]): void {
  for (let i = 0; i < opts.length; i++) {
    const arg = opts[i]!;
    if (arg === "-f") {
      throw new ZellijError(
        "bad_ssh",
        "ZSWARM_SSH_OPTS must not daemonize ssh (-f); zswarm owns a foreground LocalForward child",
      );
    }
    if (arg === "-L" || arg.startsWith("-L") || arg === "-R" || arg.startsWith("-R") || arg === "-D" || arg.startsWith("-D")) {
      throw new ZellijError(
        "bad_ssh",
        "ZSWARM_SSH_OPTS must not add extra forwards; zswarm owns -L",
      );
    }
    const option = sshOptionAt(opts, i);
    if (!option) continue;
    i += option.consumed - 1;
    if (option.name === "controlmaster" && !isDisabled(option.value)) {
      throw new ZellijError(
        "bad_ssh",
        `ZSWARM_SSH_OPTS ControlMaster=${option.value} would outlive the tracked ssh child; zswarm uses a foreground-owned tunnel`,
      );
    }
    if (option.name === "controlpersist" && !isDisabled(option.value)) {
      throw new ZellijError(
        "bad_ssh",
        `ZSWARM_SSH_OPTS ControlPersist=${option.value} would outlive the tracked ssh child`,
      );
    }
    if (option.name === "forkafterauthentication" && !isDisabled(option.value)) {
      throw new ZellijError(
        "bad_ssh",
        "ZSWARM_SSH_OPTS must not fork the ssh child",
      );
    }
    if (option.name === "exitonforwardfailure" && isDisabled(option.value) && option.value !== "") {
      throw new ZellijError(
        "bad_ssh",
        "ZSWARM_SSH_OPTS must not disable ExitOnForwardFailure",
      );
    }
  }
}

export function buildSshTunnelArgv(
  target: ParsedSshServeTarget,
  localPort: number,
  env: NodeJS.ProcessEnv = {},
): SshTunnelArgv {
  const bin = env.ZSWARM_SSH_BIN?.trim() || "ssh";
  const userOpts = parseSshOpts(env.ZSWARM_SSH_OPTS ?? "");
  assertSafeSshTunnelOpts(userOpts);
  return {
    bin,
    args: [
      ...userOpts,
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
      "ControlPersist=no",
      "-L",
      `${SSH_SERVE_REMOTE_HOST}:${localPort}:${SSH_SERVE_REMOTE_HOST}:${target.servePort}`,
      "-p",
      String(target.sshPort),
      target.destination,
    ],
  };
}

/** Isolated identity for an owned tunnel. Never includes the serve token. */
export function serveTunnelCacheKey(
  target: ParsedSshServeTarget,
  env: NodeJS.ProcessEnv = {},
): string {
  return JSON.stringify({
    bin: env.ZSWARM_SSH_BIN?.trim() || "ssh",
    opts: parseSshOpts(env.ZSWARM_SSH_OPTS ?? ""),
    destination: target.destination,
    sshPort: target.sshPort,
    serveHost: SSH_SERVE_REMOTE_HOST,
    servePort: target.servePort,
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

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
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

function remaining(deadline: number): number {
  return Math.max(0, deadline - Date.now());
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

const defaultSpawn: SshTunnelSpawn = (bin, args, options) =>
  spawn(bin, args, options);

function enqueue(
  chains: Map<string, Promise<unknown>>,
  key: string,
  work: () => Promise<ServeTunnelAcquireSuccess | OpsResult>,
): Promise<ServeTunnelAcquireSuccess | OpsResult> {
  const prev = chains.get(key) ?? Promise.resolve();
  const next = prev.then(work, work);
  chains.set(
    key,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

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
  const tunnels = new Map<string, TunnelEntry>();
  const chains = new Map<string, Promise<unknown>>();

  const stopEntry = async (entry: TunnelEntry): Promise<void> => {
    if (entry.stopping) {
      await entry.stopping;
      return;
    }
    entry.stopping = stopChild(entry.child).then(() => {
      if (tunnels.get(entry.key) === entry) tunnels.delete(entry.key);
    });
    await entry.stopping;
  };

  const makeHandle = (entry: TunnelEntry): ServeTunnelHandle => {
    let released = false;
    return {
      localTarget: entry.localTarget,
      identity: entry.identity,
      release: async () => {
        if (released) return;
        released = true;
        entry.refs = Math.max(0, entry.refs - 1);
        if (entry.refs === 0 && !persistIdle) await stopEntry(entry);
      },
      invalidate: async () => {
        released = true;
        entry.refs = 0;
        await stopEntry(entry);
      },
    };
  };

  const adopt = (entry: TunnelEntry): ServeTunnelAcquireSuccess => {
    entry.refs += 1;
    return { ok: true, handle: makeHandle(entry), localTarget: entry.localTarget };
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
      if (signal?.aborted) throw new ZellijError("cancelled", "operation cancelled");
      if (remaining(deadline) <= 0) {
        throw new ZellijError(
          "timeout",
          `ssh LocalForward timed out (${formatSshServeTarget(target)})`,
        );
      }
      const localPort = await allocatePort();
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
        if (tunnels.get(entry.key) === entry) tunnels.delete(entry.key);
      });

      const started = Date.now();
      while (childAlive(child) && remaining(deadline) > 0 && !signal?.aborted) {
        const ok = await waitForTcp(
          localPort,
          Math.min(TCP_PROBE_MS, remaining(deadline)),
          signal,
        );
        if (ok) return entry;
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
      await stopChild(child);
      if (signal?.aborted) throw new ZellijError("cancelled", "operation cancelled");
      if (!isLocalBindFailure(stderr) && child.exitCode !== 0 && Date.now() - started < 400) {
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
    while (childAlive(entry.child) && remaining(deadline) > 0 && !signal?.aborted) {
      const result = await probe(entry.localTarget, {
        token,
        timeoutMs: Math.min(2_000, remaining(deadline)),
        signal,
      });
      last = result;
      if (result.ok) return result;
      if (isFinalProbeFailure(result)) return result;
      await sleep(Math.min(SPAWN_RETRY_MS, remaining(deadline) || SPAWN_RETRY_MS), signal).catch(
        () => undefined,
      );
    }
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

  const acquire: ServeTunnelManager["acquire"] = (raw, opts) => {
    const env = opts.env ?? {};
    const target = parseSshServeTarget(raw);
    const key = serveTunnelCacheKey(target, env);
    const deadline = Date.now() + Math.max(1, opts.timeoutMs);
    return enqueue(chains, key, async () => {
      if (opts.signal?.aborted) return cancelledResult();
      const existing = tunnels.get(key);
      if (existing && childAlive(existing.child) && !existing.stopping) {
        return adopt(existing);
      }
      if (existing) await stopEntry(existing);
      const entry = await spawnOwned(target, env, opts.token, deadline, opts.signal);
      const probed = await probeReady(entry, opts.token, deadline, opts.signal);
      if (!probed.ok) {
        await stopChild(entry.child);
        return probed;
      }
      tunnels.set(key, entry);
      return adopt(entry);
    });
  };

  return {
    acquire,
    closeAll: async () => {
      const entries = [...tunnels.values()];
      tunnels.clear();
      await Promise.all(entries.map((entry) => stopEntry(entry)));
    },
    ownedCount: () => tunnels.size,
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
}): Promise<OpsResult> {
  const target = input.target.trim();
  const timeoutMs = Math.max(1, input.timeoutMs);
  const request = stripControllerRouting(input.args);
  if (!isSshServeTarget(target)) {
    return callServe(target, request, timeoutMs, input.token, input.signal);
  }
  const owned = input.manager;
  const manager = owned ?? createServeTunnelManager({ persistIdle: false });
  const deadline = Date.now() + timeoutMs;
  const acquireOpts = (): AcquireServeTunnelOptions => ({
    env: input.env,
    token: input.token,
    timeoutMs: remaining(deadline),
    signal: input.signal,
  });
  try {
    if (input.signal?.aborted) return cancelledResult();
    const first = await manager.acquire(target, acquireOpts());
    if (!isAcquireSuccess(first)) return first;
    try {
      let result = await callServe(
        first.localTarget,
        request,
        remaining(deadline),
        input.token,
        input.signal,
      );
      if (isNotSentConnectFailure(result) && remaining(deadline) > 0 && !input.signal?.aborted) {
        await first.handle.invalidate();
        const again = await manager.acquire(target, acquireOpts());
        if (!isAcquireSuccess(again)) return again;
        try {
          result = await callServe(
            again.localTarget,
            request,
            remaining(deadline),
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
