import { createServer, connect, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { hostname } from "node:os";
import { ZellijError } from "../errors.js";
import type { OpsResult } from "./types.js";

export const DEFAULT_SERVE_LISTEN = "127.0.0.1:9419";
export const SERVE_TASK_NAME = "zswarm-serve";
/** One JSONL request; a client that never sends newline cannot grow forever. */
export const SERVE_MAX_REQUEST_BYTES = 1024 * 1024;
/**
 * Zellij `execFile` capture budget (`maxBuffer`). `dump --max 0` can return
 * that much pane text; serve JSONL is UTF-8 and may expand (newlines → `\n`).
 */
export const SERVE_CAPTURE_BUDGET_BYTES = 8 * 1024 * 1024;
/**
 * Ordinary JSONL reply cap, UTF-8 bytes of the complete frame including the
 * terminating newline. Sized for an 8MiB capture with newline escaping (2×)
 * plus envelope slack. Not a silent truncate: over-cap fails with
 * `serve_protocol`. Override with `ZSWARM_SERVE_MAX_REPLY_BYTES`.
 */
export const SERVE_MAX_REPLY_BYTES = SERVE_CAPTURE_BUDGET_BYTES * 2 + 256 * 1024;
/** Hello is a small control reply; keep it independent of dump-sized ops. */
export const SERVE_MAX_HELLO_BYTES = 16 * 1024;
/** Drop a socket that never finishes a JSONL line. */
export const SERVE_IDLE_TIMEOUT_MS = 30_000;
/** Concurrent TCP clients, including in-flight wait ops. */
export const SERVE_MAX_CONNECTIONS = 32;
/** Wait/await allow 15 minutes; this is that plus slack. */
export const SERVE_CALL_TIMEOUT_CAP_MS = 16 * 60_000;
/** TCP connect is bounded even when the op wait budget is long. */
export const SERVE_CONNECT_TIMEOUT_MS = 15_000;
/** Hello probe wait is bounded within the overall deadline. */
export const SERVE_HELLO_TIMEOUT_MS = 15_000;
/** Wire protocol number returned by hello. */
export const SERVE_PROTOCOL = 1;
export const SERVE_CONTROL_FIELD = "serveControl";
export const SERVE_HELLO_CONTROL = "hello";
export const SERVE_CAPABILITY_HELLO = "hello";
/** Per-launch identity for Windows install verification. Additive hello field. */
export const SERVE_LAUNCH_ID_ENV = "ZSWARM_SERVE_LAUNCH_ID";
const SERVE_TOKEN_FIELD = "serveToken";

const CORE_VERSION = readCoreVersion();

function readCoreVersion(): string {
  const pkg = createRequire(import.meta.url)("../../package.json") as {
    version?: unknown;
  };
  if (typeof pkg.version !== "string" || !pkg.version.trim()) {
    throw new Error("@zswarm/core package.json is missing version");
  }
  return pkg.version.trim();
}

export type ServePhase = "connect" | "hello" | "request";
/** Conservative: `uncertain` means a request was written and no complete reply arrived. */
export type ServeDelivery = "not_sent" | "uncertain" | "replied";
export type ServeErrorDetails = {
  phase: ServePhase;
  endpoint: string;
  delivery: ServeDelivery;
  remedy: string;
};
export type ServeCapability = typeof SERVE_CAPABILITY_HELLO;
export type ServeHelloData = {
  protocol: number;
  serverId: string;
  hostname: string;
  platform: string;
  version: string;
  capabilities: string[];
  /** Present when the process was started with `ZSWARM_SERVE_LAUNCH_ID`. */
  launchId?: string;
};
export type ProbeServeOptions = {
  token?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
};
export type CallServeOptions = {
  timeoutMs?: number;
  token?: string;
  signal?: AbortSignal;
  maxReplyBytes?: number;
  connectTimeoutMs?: number;
};

export const SERVE_REMEDY = {
  connect:
    "Check that zswarm serve is running and the tunnel still forwards to this endpoint. Serve does not fall back to SSH.",
  unauthorized:
    "Set the same ZSWARM_SERVE_TOKEN on the server and this caller.",
  helloUnsupported:
    "This endpoint does not speak serve hello (protocol 1). Upgrade zswarm serve. Ordinary commands still work without probing hello first.",
  incompatible:
    "This serve protocol is not supported by this client. Upgrade zswarm on both sides.",
  protocol:
    "The endpoint returned a malformed or unexpected serve reply. Do not echo or retry blindly.",
  timeoutConnect:
    "The TCP connection did not complete in time. Check the tunnel and that zswarm serve is listening.",
  timeoutHello:
    "Connected but serve hello did not finish. Check the tunnel; do not treat this as a completed command.",
  timeoutRequest:
    "The request was sent but no reply arrived. Treat the remote outcome as uncertain; do not retry automatically.",
  incomplete:
    "The connection closed before a complete reply. If a request was already sent, treat the remote outcome as uncertain; do not retry automatically.",
  cancelled:
    "The caller cancelled this serve call. If a request was already sent, treat the remote outcome as uncertain; do not retry automatically.",
} as const;

export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return (
    h === "127.0.0.1" ||
    h === "localhost" ||
    h === "::1" ||
    h === "0:0:0:0:0:0:0:1"
  );
}

export function formatListenLabel(host: string, port: number): string {
  return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
}

export function parseListenAddress(raw: string | undefined): {
  host: string;
  port: number;
  label: string;
} {
  const text = (raw ?? DEFAULT_SERVE_LISTEN).trim() || DEFAULT_SERVE_LISTEN;
  const stripped = text.replace(/^tcp:\/\//i, "");
  let host: string;
  let port: number;
  if (stripped.startsWith("[")) {
    const end = stripped.indexOf("]");
    if (end === -1) {
      throw new ZellijError("bad_arg", `listen address is not host:port (${text})`);
    }
    host = stripped.slice(1, end);
    const rest = stripped.slice(end + 1);
    if (!rest.startsWith(":")) {
      throw new ZellijError("bad_arg", `listen address is not host:port (${text})`);
    }
    port = Number(rest.slice(1));
  } else {
    const hostPort = stripped.includes(":")
      ? stripped
      : `127.0.0.1:${stripped}`;
    const colon = hostPort.lastIndexOf(":");
    host = colon === -1 ? "127.0.0.1" : hostPort.slice(0, colon) || "127.0.0.1";
    port = Number(colon === -1 ? hostPort : hostPort.slice(colon + 1));
  }
  if (!host || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ZellijError("bad_arg", `listen address is not host:port (${text})`);
  }
  return { host, port, label: formatListenLabel(host, port) };
}

/** Client-side wait: the op's own timeout plus slack. */
export function serveCallTimeout(args: Record<string, unknown>): number {
  const requested = Number(args.timeoutMs);
  const base = Number.isFinite(requested) && requested > 0 ? requested : 60_000;
  return Math.min(Math.max(base + 5_000, 15_000), SERVE_CALL_TIMEOUT_CAP_MS);
}

/** Env for a serve worker: talk to the local Zellij, never loop back into serve/ssh. */
export function serveChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  delete out.ZSWARM_SERVE;
  delete out.ZSWARM_SSH;
  return out;
}

export type ServeDispatch = (
  args: Record<string, unknown>,
) => Promise<OpsResult>;

export type StartServeOptions = {
  token?: string;
  maxRequestBytes?: number;
  idleTimeoutMs?: number;
  maxConnections?: number;
  /** Additive hello field; omitted on ordinary foreground `serve --listen`. */
  launchId?: string;
};

function unauthorized(): OpsResult {
  return {
    ok: false,
    error: {
      code: "serve_unauthorized",
      message: "zswarm serve rejected the request (missing or wrong ZSWARM_SERVE_TOKEN)",
    },
  };
}

function protocolError(message: string): OpsResult {
  return {
    ok: false,
    error: {
      code: "serve_protocol",
      message,
    },
  };
}

function takeServeToken(
  args: Record<string, unknown>,
): { token: string | undefined; request: Record<string, unknown> } {
  const token =
    typeof args[SERVE_TOKEN_FIELD] === "string"
      ? args[SERVE_TOKEN_FIELD]
      : undefined;
  const request = { ...args };
  delete request[SERVE_TOKEN_FIELD];
  return { token, request };
}

function helloData(serverId: string, launchId?: string): ServeHelloData {
  const data: ServeHelloData = {
    protocol: SERVE_PROTOCOL,
    serverId,
    hostname: hostname() || "unknown",
    platform: process.platform,
    version: CORE_VERSION,
    capabilities: [SERVE_CAPABILITY_HELLO],
  };
  const id = launchId?.trim();
  if (id) data.launchId = id;
  return data;
}

function isHelloOp(op: unknown): boolean {
  return typeof op === "string" && op.trim() === SERVE_HELLO_CONTROL;
}

/** Control plane after auth; never dispatches an application op for hello. */
function handleServeControl(
  request: Record<string, unknown>,
  hello: ServeHelloData,
): { handled: true; result: OpsResult } | { handled: false } {
  const hasControl = Object.prototype.hasOwnProperty.call(request, SERVE_CONTROL_FIELD);
  const hasOp = Object.prototype.hasOwnProperty.call(request, "op");
  if (hasControl && hasOp) {
    return {
      handled: true,
      result: protocolError("serve request cannot include both serveControl and op"),
    };
  }
  if (hasControl) {
    const control = request[SERVE_CONTROL_FIELD];
    if (typeof control !== "string" || !control.trim()) {
      return {
        handled: true,
        result: protocolError("serveControl must be a non-empty string"),
      };
    }
    const name = control.trim();
    if (name !== SERVE_HELLO_CONTROL) {
      return {
        handled: true,
        result: protocolError(`unknown serve control (${name})`),
      };
    }
    return {
      handled: true,
      result: { ok: true, data: { ...hello, capabilities: [...hello.capabilities] } },
    };
  }
  if (isHelloOp(request.op)) {
    return {
      handled: true,
      result: { ok: true, data: { ...hello, capabilities: [...hello.capabilities] } },
    };
  }
  return { handled: false };
}

export function startServe(
  listen: string | undefined,
  dispatch: ServeDispatch,
  options: StartServeOptions = {},
): Promise<{ label: string; close: () => Promise<void> }> {
  const { host, port } = parseListenAddress(listen);
  if (!isLoopbackHost(host)) {
    return Promise.reject(
      new ZellijError(
        "serve_auth",
        `zswarm serve only listens on loopback (127.0.0.1 / ::1); off-machine access is an SSH tunnel to 127.0.0.1 (${host} refused)`,
      ),
    );
  }
  const token = options.token?.trim() || undefined;
  if (!token) {
    return Promise.reject(
      new ZellijError(
        "serve_auth",
        "zswarm serve requires ZSWARM_SERVE_TOKEN; another local OS user can connect to 127.0.0.1",
      ),
    );
  }
  const maxRequestBytes = options.maxRequestBytes ?? SERVE_MAX_REQUEST_BYTES;
  const idleTimeoutMs = options.idleTimeoutMs ?? SERVE_IDLE_TIMEOUT_MS;
  const maxConnections = options.maxConnections ?? SERVE_MAX_CONNECTIONS;
  const hello = helloData(randomUUID(), options.launchId);
  return new Promise((resolve, reject) => {
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      socket.on("error", () => {
        socket.destroy();
      });
      if (sockets.size >= maxConnections) {
        socket.destroy();
        return;
      }
      sockets.add(socket);
      socket.on("close", () => {
        sockets.delete(socket);
      });
      let buf = "";
      let draining = false;
      socket.setEncoding("utf8");
      socket.setTimeout(idleTimeoutMs);
      socket.on("timeout", () => {
        socket.destroy();
      });
      socket.on("data", (chunk: string) => {
        buf += chunk;
        if (buf.length > maxRequestBytes) {
          socket.write(
            `${JSON.stringify({
              ok: false,
              error: {
                code: "bad_arg",
                message: `serve request exceeded ${maxRequestBytes} bytes`,
              },
            })}\n`,
          );
          socket.destroy();
          return;
        }
        void drain();
      });
      async function drain() {
        if (draining) return;
        draining = true;
        socket.setTimeout(0);
        try {
          let nl = buf.indexOf("\n");
          while (nl !== -1) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (line) {
              let result: OpsResult | undefined;
              let parsed: unknown;
              try {
                parsed = JSON.parse(line);
              } catch {
                result = { ok: false, error: { code: "bad_arg", message: "serve request is not JSON" } };
              }
              if (!result) {
                try {
                  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
                    result = protocolError("serve request must be a JSON object");
                  } else {
                    const taken = takeServeToken(parsed as Record<string, unknown>);
                    if (taken.token !== token) {
                      result = unauthorized();
                    } else {
                      const control = handleServeControl(taken.request, hello);
                      result = control.handled
                        ? control.result
                        : await dispatch(taken.request);
                    }
                  }
                } catch (err) {
                  const message = err instanceof Error ? err.message : "serve dispatch failed";
                  result = { ok: false, error: { code: "failed", message } };
                }
              }
              if (!socket.destroyed) {
                socket.write(`${JSON.stringify(result)}\n`);
              }
            }
            nl = buf.indexOf("\n");
          }
        } finally {
          draining = false;
          if (socket.destroyed) return;
          if (buf.includes("\n")) {
            void drain();
          } else {
            socket.setTimeout(idleTimeoutMs);
          }
        }
      }
    });
    server.on("error", reject);
    server.listen(port, host, () => {
      const addr = server.address();
      const actualPort =
        typeof addr === "object" && addr ? addr.port : port;
      resolve({
        label: formatListenLabel(host, actualPort),
        close: () =>
          new Promise((done, fail) => {
            for (const open of sockets) open.destroy();
            server.close((err) => (err ? fail(err) : done()));
          }),
      });
    });
  });
}

/** Direct host:port / tcp:// only. ssh:// URIs are resolved by serve-tunnel. */
export function parseServeTarget(raw: string): { host: string; port: number } {
  return parseListenAddress(raw);
}

function serveFail(code: string, message: string, details: ServeErrorDetails): OpsResult {
  return { ok: false, error: { code, message, details } };
}

function remedyFor(code: string, phase: ServePhase, delivery: ServeDelivery): string {
  if (code === "serve_unauthorized") return SERVE_REMEDY.unauthorized;
  if (code === "cancelled") return SERVE_REMEDY.cancelled;
  if (code === "serve_unreachable") return SERVE_REMEDY.connect;
  if (code === "serve_hello_unsupported") return SERVE_REMEDY.helloUnsupported;
  if (code === "serve_incompatible") return SERVE_REMEDY.incompatible;
  if (code === "timeout") {
    if (phase === "connect") return SERVE_REMEDY.timeoutConnect;
    if (phase === "hello") return SERVE_REMEDY.timeoutHello;
    if (delivery === "uncertain") return SERVE_REMEDY.timeoutRequest;
    return SERVE_REMEDY.timeoutConnect;
  }
  if (delivery === "uncertain") return SERVE_REMEDY.incomplete;
  return SERVE_REMEDY.protocol;
}

function asOpsResult(value: unknown): OpsResult | null {
  if (!value || typeof value !== "object") return null;
  const v = value as { ok?: unknown; error?: unknown };
  if (v.ok === true) {
    if (!Object.prototype.hasOwnProperty.call(v, "data")) return null;
    return value as OpsResult;
  }
  if (v.ok !== false || !v.error || typeof v.error !== "object") return null;
  const error = v.error as { code?: unknown; message?: unknown };
  if (typeof error.code !== "string" || typeof error.message !== "string") return null;
  return value as OpsResult;
}

/** CLI/MCP inherit `process.env`; a positive integer overrides the default reply cap. */
export function serveMaxReplyBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ZSWARM_SERVE_MAX_REPLY_BYTES?.trim();
  if (!raw) return SERVE_MAX_REPLY_BYTES;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return SERVE_MAX_REPLY_BYTES;
  return Math.floor(n);
}

function replyByteLimit(
  phase: Exclude<ServePhase, "connect">,
  override: number | undefined,
): number {
  if (typeof override === "number" && Number.isFinite(override) && override > 0) {
    return Math.floor(override);
  }
  if (phase === "hello") return SERVE_MAX_HELLO_BYTES;
  return serveMaxReplyBytes();
}

function isServeHelloData(data: unknown): data is ServeHelloData {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  return (
    typeof d.protocol === "number" &&
    Number.isFinite(d.protocol) &&
    typeof d.serverId === "string" &&
    d.serverId.trim() !== "" &&
    typeof d.hostname === "string" &&
    d.hostname.trim() !== "" &&
    typeof d.platform === "string" &&
    d.platform.trim() !== "" &&
    typeof d.version === "string" &&
    d.version.trim() !== "" &&
    Array.isArray(d.capabilities) &&
    d.capabilities.every((cap) => typeof cap === "string" && cap.trim() !== "")
  );
}

function attachToken(
  args: Record<string, unknown>,
  token?: string,
): Record<string, unknown> {
  return token && token.trim() ? { ...args, [SERVE_TOKEN_FIELD]: token.trim() } : args;
}

function exchangeServe(input: {
  target: string;
  payload: Record<string, unknown>;
  timeoutMs: number;
  phase: Exclude<ServePhase, "connect">;
  signal?: AbortSignal;
  maxReplyBytes?: number;
  connectTimeoutMs?: number;
}): Promise<OpsResult> {
  const { host, port } = parseServeTarget(input.target);
  const endpoint = formatListenLabel(host, port);
  const timeoutMs = Math.max(1, input.timeoutMs);
  const deadline = Date.now() + timeoutMs;
  const maxReplyBytes = replyByteLimit(input.phase, input.maxReplyBytes);
  const remaining = () => Math.max(0, deadline - Date.now());

  return new Promise((resolve) => {
    let phase: ServePhase = "connect";
    let sent = false;
    let settled = false;
    let pending = Buffer.alloc(0);
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    let waitTimer: ReturnType<typeof setTimeout> | undefined;
    let overallTimer: ReturnType<typeof setTimeout> | undefined;
    let socket: Socket | undefined;

    const delivery = (): ServeDelivery => (sent ? "uncertain" : "not_sent");

    const finish = (result: OpsResult) => {
      if (settled) return;
      settled = true;
      if (connectTimer) clearTimeout(connectTimer);
      if (waitTimer) clearTimeout(waitTimer);
      if (overallTimer) clearTimeout(overallTimer);
      input.signal?.removeEventListener("abort", onAbort);
      if (socket) {
        socket.removeAllListeners();
        socket.destroy();
      }
      resolve(result);
    };

    const fail = (code: string, message: string, state: ServeDelivery = delivery()) => {
      finish(serveFail(code, message, {
        phase,
        endpoint,
        delivery: state,
        remedy: remedyFor(code, phase, state),
      }));
    };

    const onAbort = () => {
      fail("cancelled", "operation cancelled");
    };

    if (input.signal?.aborted) {
      fail("cancelled", "operation cancelled");
      return;
    }

    if (remaining() <= 0) {
      fail("timeout", `zswarm serve at ${endpoint} timed out after ${timeoutMs}ms`);
      return;
    }

    socket = connect({ host, port });
    input.signal?.addEventListener("abort", onAbort, { once: true });

    overallTimer = setTimeout(() => {
      fail("timeout", `zswarm serve at ${endpoint} timed out after ${timeoutMs}ms`);
    }, timeoutMs);

    connectTimer = setTimeout(() => {
      fail("timeout", `zswarm serve at ${endpoint} timed out after ${timeoutMs}ms`);
    }, Math.max(1, Math.min(input.connectTimeoutMs ?? SERVE_CONNECT_TIMEOUT_MS, remaining())));

    socket.on("error", (err) => {
      if (phase === "connect" && !sent) {
        fail("serve_unreachable", `cannot reach zswarm serve at ${endpoint}: ${err.message}`);
        return;
      }
      fail("serve_protocol", `zswarm serve at ${endpoint} closed before a complete reply`);
    });

    socket.on("connect", () => {
      if (settled || !socket) return;
      if (connectTimer) {
        clearTimeout(connectTimer);
        connectTimer = undefined;
      }
      phase = input.phase;
      const waitBound =
        phase === "hello" ? Math.min(SERVE_HELLO_TIMEOUT_MS, remaining()) : remaining();
      if (waitBound <= 0) {
        fail("timeout", `zswarm serve at ${endpoint} timed out after ${timeoutMs}ms`);
        return;
      }
      if (phase === "hello") {
        waitTimer = setTimeout(() => {
          fail("timeout", `zswarm serve at ${endpoint} timed out after ${timeoutMs}ms`);
        }, Math.max(1, waitBound));
      }
      sent = true;
      try {
        socket.write(`${JSON.stringify(input.payload)}\n`);
      } catch {
        fail("serve_protocol", `zswarm serve at ${endpoint} closed before a complete reply`);
      }
    });

    socket.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
      pending = Buffer.concat([pending, bytes]);
      // Cap counts the complete JSONL frame in UTF-8, including the newline.
      if (pending.length > maxReplyBytes) {
        fail("serve_protocol", `serve reply exceeded ${maxReplyBytes} bytes`);
        return;
      }
      while (!settled) {
        const nl = pending.indexOf(0x0a);
        if (nl === -1) return;
        const line = pending.subarray(0, nl).toString("utf8").trim();
        pending = pending.subarray(nl + 1);
        if (!line) continue;
        try {
          const parsed = asOpsResult(JSON.parse(line) as unknown);
          if (!parsed) {
            fail(
              "serve_protocol",
              `zswarm serve at ${endpoint} returned an invalid reply`,
              "replied",
            );
            return;
          }
          finish(parsed);
        } catch {
          fail(
            "serve_protocol",
            `zswarm serve at ${endpoint} returned non-JSON`,
            "replied",
          );
        }
        return;
      }
    });

    const onClosed = () => {
      if (settled) return;
      if (pending.length > 0) {
        fail("serve_protocol", `zswarm serve at ${endpoint} returned a truncated reply`);
        return;
      }
      fail("serve_protocol", `zswarm serve at ${endpoint} closed before a complete reply`);
    };
    socket.on("end", onClosed);
    socket.on("close", onClosed);
  });
}

function interpretServeHello(result: OpsResult, endpoint: string): OpsResult {
  if (!result.ok) {
    if (
      result.error.code === "serve_unauthorized" ||
      result.error.code === "serve_unreachable" ||
      result.error.code === "timeout" ||
      result.error.code === "cancelled" ||
      result.error.code === "serve_protocol" ||
      result.error.code === "serve_incompatible" ||
      result.error.code === "serve_hello_unsupported"
    ) {
      return result;
    }
    return serveFail(
      "serve_hello_unsupported",
      `zswarm serve at ${endpoint} does not speak hello (protocol ${SERVE_PROTOCOL})`,
      {
        phase: "hello",
        endpoint,
        delivery: "replied",
        remedy: SERVE_REMEDY.helloUnsupported,
      },
    );
  }
  const data = result.data;
  if (data && typeof data === "object" && typeof (data as { protocol?: unknown }).protocol === "number") {
    const protocol = (data as { protocol: number }).protocol;
    if (protocol !== SERVE_PROTOCOL) {
      return serveFail(
        "serve_incompatible",
        `zswarm serve at ${endpoint} speaks protocol ${protocol}; this client supports ${SERVE_PROTOCOL}`,
        {
          phase: "hello",
          endpoint,
          delivery: "replied",
          remedy: SERVE_REMEDY.incompatible,
        },
      );
    }
    if (
      !isServeHelloData(data) ||
      !data.capabilities.includes(SERVE_CAPABILITY_HELLO)
    ) {
      return serveFail(
        "serve_protocol",
        `zswarm serve at ${endpoint} returned an invalid hello`,
        {
          phase: "hello",
          endpoint,
          delivery: "replied",
          remedy: SERVE_REMEDY.protocol,
        },
      );
    }
    return { ok: true, data };
  }
  return serveFail(
    "serve_hello_unsupported",
    `zswarm serve at ${endpoint} does not speak hello (protocol ${SERVE_PROTOCOL})`,
    {
      phase: "hello",
      endpoint,
      delivery: "replied",
      remedy: SERVE_REMEDY.helloUnsupported,
    },
  );
}

export function callServe(
  target: string,
  args: Record<string, unknown>,
  timeoutMsOrOptions: number | CallServeOptions = 15_000,
  token?: string,
  signal?: AbortSignal,
): Promise<OpsResult> {
  const options: CallServeOptions =
    typeof timeoutMsOrOptions === "object" && timeoutMsOrOptions !== null
      ? timeoutMsOrOptions
      : { timeoutMs: timeoutMsOrOptions, token, signal };
  return exchangeServe({
    target,
    payload: attachToken(args, options.token),
    timeoutMs: options.timeoutMs ?? 15_000,
    phase: "request",
    signal: options.signal,
    maxReplyBytes: options.maxReplyBytes,
    connectTimeoutMs: options.connectTimeoutMs,
  });
}

/** Authenticated hello probe. Never reports a legacy or incompatible endpoint as healthy. */
export function probeServe(
  target: string,
  options: ProbeServeOptions = {},
): Promise<OpsResult> {
  const { label: endpoint } = parseListenAddress(target);
  return exchangeServe({
    target,
    payload: attachToken({ [SERVE_CONTROL_FIELD]: SERVE_HELLO_CONTROL }, options.token),
    timeoutMs: options.timeoutMs ?? 15_000,
    phase: "hello",
    signal: options.signal,
  }).then((result) => interpretServeHello(result, endpoint));
}

export function redactServeSecret(command: string, token: string): string {
  const secret = token.trim();
  if (!secret) return command;
  return command.split(secret).join("***");
}

export function serveLogonCommand(
  execPath: string,
  scriptPath: string,
  listen: string,
  token?: string,
  extraEnv: Record<string, string> = {},
): string {
  for (const path of [execPath, scriptPath]) {
    if (/[\0\r\n"]/.test(path)) {
      throw new ZellijError(
        "bad_arg",
        "serve executable/script path must not contain quotes or newlines",
      );
    }
  }
  const launch = `"${execPath}" "${scriptPath}" serve --listen ${listen}`;
  const env: Record<string, string> = { ...extraEnv };
  const secret = token?.trim();
  if (secret) env.ZSWARM_SERVE_TOKEN = secret;
  const assignments: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!value) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new ZellijError("bad_arg", `cannot persist environment key ${key} in the logon task`);
    }
    if (/[\0\r\n"%]/.test(value)) {
      throw new ZellijError(
        "bad_arg",
        key === "ZSWARM_SERVE_TOKEN"
          ? "ZSWARM_SERVE_TOKEN must not contain quotes, newlines, or %"
          : `${key} must not contain quotes, newlines, or %`,
      );
    }
    assignments.push(`set "${key}=${value}"`);
  }
  if (assignments.length === 0) return launch;
  return `${assignments.join("&& ")}&& ${launch}`;
}
