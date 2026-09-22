import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { ZellijError } from "../errors.js";
import { NOT_FOUND_EXIT } from "../exec.js";
import { isBusPluginPane, resolveBusPlugin } from "../zellij/bus.js";
import { createZellijClient, type ZellijClient } from "../zellij/client.js";
import {
  liveSessionNames,
  sessionFromEnv,
  type ZellijSession,
  type ZellijSessionResolve,
} from "../zellij/session.js";
import { createStateStore, type StateStore } from "../state.js";
import { validateSshMode } from "../zellij/binary.js";
import { observationBudget } from "./observation.js";
import type { RoutingContext } from "./routing.js";
import {
  callServe,
  probeServe,
  serveChildEnv,
  type ServeHelloData,
} from "./serve.js";
import {
  createServeTunnelManager,
  describeServeTarget,
  isSshServeTarget,
  parseSshServeTarget,
  type ServeTunnelHandle,
  type ServeTunnelManager,
} from "./serve-tunnel.js";
import type { Clock, DispatchDeps, OpsResult } from "./types.js";
import { numberArg, optionalString, throwIfAborted } from "./util.js";

/** Overall doctor deadline when `timeoutMs` is omitted. */
export const DEFAULT_DOCTOR_TIMEOUT_MS = 10_000;
/** Internal serve-worker flag. Never a public CLI flag or MCP param. */
export const DOCTOR_SCOPE_FIELD = "doctorScope";
export const DOCTOR_SCOPE_HOST = "host";
export const DOCTOR_FAILED_CODE = "doctor_failed";
/** Host doctor reply after hello was empty, malformed, or not a report. */
export const HOST_REPORT_INVALID_CODE = "host_report_invalid";
/** Host doctor reply omitted required host/session coverage. */
export const HOST_REPORT_INCOMPLETE_CODE = "host_report_incomplete";
/** Cap for optional Tailscale so required SSH/hello/session keep budget. */
export const DOCTOR_TAILSCALE_MAX_MS = 1_500;
const DOCTOR_TAILSCALE_RESERVE_MS = 4_000;
const DOCTOR_TAILSCALE_MIN_MS = 200;
const DOCTOR_TAILSCALE_MAX_BYTES = 256 * 1024;

export type DoctorCheckState = "ok" | "warn" | "fail" | "skipped";
export type DoctorCheckScope = "controller" | "host";

export type DoctorCheck = {
  id: string;
  scope: DoctorCheckScope;
  state: DoctorCheckState;
  code: string;
  elapsedMs: number;
  detail: Record<string, unknown>;
  remedy: string | null;
};

export type DoctorRoute = {
  transport: "local" | "ssh" | "serve";
  endpoint: string;
  session: string | null;
  sessionOrigin: string;
};

export type DoctorReport = {
  route: DoctorRoute;
  server?: ServeHelloData;
  checks: DoctorCheck[];
};

export type HostInspectInput = {
  client: ZellijClient;
  state: StateStore;
  env: NodeJS.ProcessEnv;
  sessionArg?: string | null;
  clock: Clock;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Direct SSH cannot treat controller-local bus files as host facts. */
  busUnsupported?: boolean;
  busRemedy?: string;
};

export type HostInspectResult = {
  checks: DoctorCheck[];
  session: string | null;
  sessionOrigin: string;
  cancelled?: boolean;
  timedOut?: boolean;
};

const HOST_CHECK_IDS = [
  "zellij_binary",
  "zellij_ipc",
  "zellij_sessions",
  "session",
  "bus_artifact",
  "bus_marker",
  "bus_instance",
] as const;

const REMEDY = {
  serve:
    "Run zswarm serve beside Zellij on the crew host and reach it with --serve (ssh:// or an existing tunnel). Direct SSH cannot install or inspect the event bus.",
  token: "Set the same ZSWARM_SERVE_TOKEN on the server and this caller.",
  upgrade:
    "This serve peer does not implement doctor. Upgrade zswarm serve on the crew host, then rerun doctor.",
  hostReport:
    "Authenticated hello succeeded, but the host doctor reply was missing, malformed, or did not cover host/session inspection. Upgrade zswarm serve on the crew host and rerun doctor.",
  session:
    "Start the requested Zellij session on the crew host (the account that owns the desktop session), or pass --session for a live session.",
  zellij:
    "Install Zellij ≥ 0.42 on the crew host and set ZSWARM_BIN / ZSWARM_REMOTE_BIN to that binary, not zswarm.",
  ipc:
    "Point ZSWARM_TMP at the desktop TEMP (or auto) so listings use the crew host IPC. A reachable listener is not a usable crew.",
  tailscale:
    "Optional Tailscale evidence only. Install/login of the Tailscale CLI is out of scope for doctor; a working SSH/serve route does not require it.",
  interactive:
    "Doctor does not run the Windows interactive scheduled-task path. Use zswarm serve on the desktop account and --serve through an SSH tunnel.",
} as const;

function asDetails(report: DoctorReport): Record<string, unknown> {
  return report as unknown as Record<string, unknown>;
}

function originLabel(source: string | undefined): string {
  if (source === "arg") return "explicit";
  if (source === "env_zswarm" || source === "env_zellij") return "inherited";
  if (source === "sole_live") return "host_default";
  if (source === "server") return "server";
  if (source === "unresolved" || !source) return "unresolved";
  return source;
}

function elapsedSince(clock: Clock, started: number): number {
  return Math.max(0, Math.round(clock.now() - started));
}

function check(
  id: string,
  scope: DoctorCheckScope,
  state: DoctorCheckState,
  code: string,
  elapsedMs: number,
  detail: Record<string, unknown> = {},
  remedy: string | null = null,
): DoctorCheck {
  return { id, scope, state, code, elapsedMs, detail, remedy };
}

function skipHostChecks(
  existing: DoctorCheck[],
  reason: string,
  remedy: string,
  elapsedMs = 0,
): DoctorCheck[] {
  return HOST_CHECK_IDS.filter((id) => !existing.some((item) => item.id === id)).map((id) =>
    check(id, "host", "skipped", reason, elapsedMs, { reason }, remedy),
  );
}

function isLoopbackEndpoint(endpoint: string): boolean {
  const text = endpoint.trim().toLowerCase();
  return (
    text.startsWith("127.0.0.1") ||
    text.startsWith("localhost") ||
    text.startsWith("[::1]") ||
    text.startsWith("::1")
  );
}

function sshFailure(message: string): { code: string; remedy: string } {
  const text = message.toLowerCase();
  if (
    /permission denied|publickey|authentication failed|too many authentication|no matching host key type/.test(
      text,
    )
  ) {
    return {
      code: "ssh_auth",
      remedy:
        "SSH authentication failed. Check the identity, agent, and BatchMode destination; doctor does not prompt for a password.",
    };
  }
  if (/host key verification failed|known_hosts|remote host identification has changed/.test(text)) {
    return {
      code: "ssh_host_key",
      remedy:
        "SSH host-key verification failed. Confirm the destination in known_hosts; doctor does not disable StrictHostKeyChecking.",
    };
  }
  if (
    /remote port forwarding failed|administratively prohibited|cannot listen|channel .* failed/.test(
      text,
    )
  ) {
    return {
      code: "ssh_forward",
      remedy:
        "SSH connected but LocalForward failed. Confirm GatewayPorts/AllowTcpForwarding and that the remote loopback serve port is free.",
    };
  }
  if (
    /could not resolve|name or service not known|no route to host|network is unreachable|connection refused|connection timed out|timed out|connection reset/.test(
      text,
    )
  ) {
    return {
      code: "ssh_connect",
      remedy:
        "Cannot reach the SSH destination. Check the host/alias, Tailscale/OpenSSH connectivity, and that ssh is on PATH.",
    };
  }
  return {
    code: "ssh_connect",
    remedy:
      "SSH did not become ready. Inspect the destination and OpenSSH configuration; doctor does not fall back to another route.",
  };
}

function serveFailure(result: OpsResult): { code: string; remedy: string; detail: Record<string, unknown> } {
  const err = !result.ok ? result.error : undefined;
  const details =
    err?.details && typeof err.details === "object" ? { ...err.details } : {};
  const code = err?.code ?? "serve_protocol";
  const mapped =
    code === "serve_unauthorized"
      ? "serve_unauthorized"
      : code === "serve_hello_unsupported"
        ? "serve_hello_unsupported"
        : code === "serve_incompatible"
          ? "serve_incompatible"
          : code === "timeout"
            ? "serve_timeout"
            : code === "cancelled"
              ? "serve_cancelled"
              : code === "serve_unreachable"
                ? "serve_connect"
                : "serve_protocol";
  const remedy =
    typeof details.remedy === "string"
      ? details.remedy
      : mapped === "serve_unauthorized"
        ? REMEDY.token
        : mapped === "serve_hello_unsupported" || mapped === "serve_incompatible"
          ? REMEDY.upgrade
          : "Check that zswarm serve is listening on the forwarded loopback port. A TCP connect alone is not readiness; doctor requires authenticated hello.";
  return {
    code: mapped,
    remedy,
    detail: {
      ...details,
      message: err?.message,
      transportCode: code,
    },
  };
}

function selectedSession(args: Record<string, unknown>): string | null {
  return optionalString(args.session);
}

function controllerSessionOrigin(context: RoutingContext): string {
  return originLabel(context.origin.session);
}

function reportHas(checks: DoctorCheck[], id: string): boolean {
  return checks.some((item) => item.id === id);
}

function isRequiredFailure(report: DoctorReport, item: DoctorCheck): boolean {
  if (item.state === "ok" || item.state === "warn") return false;
  if (item.id === "route") return item.state === "fail";
  if (item.id === "ssh") {
    if (item.code === "ssh_not_applicable" || item.code === "ssh_skipped_upstream") return false;
    if (item.code === "ssh_interactive_uninspected") return false;
    return item.state === "fail";
  }
  if (item.id === "serve") {
    if (item.code === "serve_not_applicable" || item.code === "serve_skipped_upstream") {
      return false;
    }
    return item.state === "fail";
  }
  if (item.id === "zellij_binary") {
    if (item.state === "skipped") return false;
    return item.state === "fail";
  }
  if (item.id === "session") {
    const selected =
      report.route.sessionOrigin === "explicit" ||
      report.route.sessionOrigin === "inherited" ||
      report.route.sessionOrigin === "host_default";
    if (!selected) return item.state === "fail";
    return item.state === "fail" || item.state === "skipped";
  }
  return false;
}

function summarizeFailure(report: DoctorReport): string {
  const failed = report.checks.filter((item) => isRequiredFailure(report, item));
  if (failed.length === 0) return "doctor failed";
  return failed.map((item) => `${item.id}:${item.code}`).join(", ");
}

function finishReport(
  report: DoctorReport,
  status: { cancelled: boolean; timedOut: boolean },
): OpsResult {
  if (status.cancelled) {
    return {
      ok: false,
      error: {
        code: "cancelled",
        message: "operation cancelled",
        details: asDetails(report),
      },
    };
  }
  if (status.timedOut) {
    return {
      ok: false,
      error: {
        code: "timeout",
        message: "doctor timed out",
        details: asDetails(report),
      },
    };
  }
  if (report.checks.some((item) => isRequiredFailure(report, item))) {
    return {
      ok: false,
      error: {
        code: DOCTOR_FAILED_CODE,
        message: summarizeFailure(report),
        details: asDetails(report),
      },
    };
  }
  return { ok: true, data: report };
}

function defaultTailscaleStatus(input: {
  timeoutMs: number;
  signal?: AbortSignal;
  env: NodeJS.ProcessEnv;
}): Promise<{ code: number; stdout: string; stderr: string }> {
  const bin = "tailscale";
  return new Promise((resolve) => {
    execFile(
      bin,
      ["status", "--json"],
      {
        timeout: Math.max(1, input.timeoutMs),
        maxBuffer: DOCTOR_TAILSCALE_MAX_BYTES,
        windowsHide: true,
        signal: input.signal,
        env: input.env,
      },
      (error, stdout, stderr) => {
        const failure = error as
          | (Error & { code?: unknown; killed?: boolean; name?: string })
          | null;
        if (failure && typeof failure.code === "string") {
          const missing = failure.code === "ENOENT" || failure.code === "ENOTDIR";
          resolve({
            code: missing ? NOT_FOUND_EXIT : 1,
            stdout: "",
            stderr: `${failure.code}: ${failure.message}`,
          });
          return;
        }
        if (failure && (failure.killed === true || failure.name === "AbortError")) {
          resolve({
            code: -1,
            stdout: String(stdout ?? ""),
            stderr: failure.name === "AbortError" ? "tailscale cancelled" : "tailscale timed out",
          });
          return;
        }
        resolve({
          code:
            failure && typeof failure.code === "number"
              ? failure.code
              : failure
                ? 1
                : 0,
          stdout: String(stdout ?? "").slice(0, DOCTOR_TAILSCALE_MAX_BYTES),
          stderr: String(stderr ?? "").slice(0, 4_096),
        });
      },
    );
  });
}

type TailscalePeer = {
  hostName?: string;
  dnsName?: string;
  online?: boolean;
  tailscaleIPs?: string[];
};

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim() !== "");
}

function normalizeDns(name: string): string {
  return name.trim().toLowerCase().replace(/\.$/, "");
}

function peerFromStatus(raw: unknown): TailscalePeer | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const hostName = typeof row.HostName === "string" ? row.HostName : undefined;
  const dnsName = typeof row.DNSName === "string" ? row.DNSName : undefined;
  const online = typeof row.Online === "boolean" ? row.Online : undefined;
  const tailscaleIPs = asStringArray(row.TailscaleIPs);
  if (!hostName && !dnsName && tailscaleIPs.length === 0) return null;
  return { hostName, dnsName, online, tailscaleIPs };
}

function candidateHosts(endpoint: string, transport: DoctorRoute["transport"]): string[] {
  if (transport === "local") return [];
  if (transport === "ssh") {
    const dest = endpoint.trim();
    const host = dest.includes("@") ? dest.slice(dest.lastIndexOf("@") + 1) : dest;
    return host ? [host] : [];
  }
  if (isSshServeTarget(endpoint)) {
    try {
      return [parseSshServeTarget(endpoint).host];
    } catch {
      return [];
    }
  }
  const stripped = endpoint.replace(/^tcp:\/\//i, "");
  const host = stripped.startsWith("[")
    ? stripped.slice(1, stripped.indexOf("]"))
    : stripped.split(":")[0] ?? "";
  return host ? [host] : [];
}

function matchPeer(peers: TailscalePeer[], host: string): TailscalePeer | null {
  const needle = host.trim().toLowerCase();
  if (!needle) return null;
  if (needle === "127.0.0.1" || needle === "localhost" || needle === "::1") return null;
  for (const peer of peers) {
    const ips = (peer.tailscaleIPs ?? []).map((ip) => ip.toLowerCase());
    if (ips.includes(needle)) return peer;
    const dns = peer.dnsName ? normalizeDns(peer.dnsName) : "";
    const dnsShort = dns.split(".")[0] ?? "";
    const hostName = peer.hostName?.trim().toLowerCase() ?? "";
    if (dns && (needle === dns || needle === dnsShort || dns.startsWith(`${needle}.`))) {
      return peer;
    }
    if (hostName && needle === hostName) return peer;
  }
  return null;
}

async function inspectTailscale(input: {
  route: DoctorRoute;
  env: NodeJS.ProcessEnv;
  clock: Clock;
  timeoutMs: number;
  signal?: AbortSignal;
  runner: NonNullable<DispatchDeps["tailscaleStatus"]>;
}): Promise<DoctorCheck> {
  const started = input.clock.now();
  const elapsed = () => elapsedSince(input.clock, started);
  if (input.timeoutMs < DOCTOR_TAILSCALE_MIN_MS) {
    return check(
      "tailscale",
      "controller",
      "skipped",
      "tailscale_skipped",
      elapsed(),
      { reason: "budget_reserved" },
      REMEDY.tailscale,
    );
  }
  const hosts = candidateHosts(input.route.endpoint, input.route.transport);
  const host = hosts[0] ?? "";
  if (!host || isLoopbackEndpoint(host) || host === "127.0.0.1") {
    return check(
      "tailscale",
      "controller",
      "skipped",
      "tailscale_unmappable",
      elapsed(),
      {
        reason: "loopback_or_manual_tunnel",
        endpoint: input.route.endpoint,
      },
      REMEDY.tailscale,
    );
  }
  try {
    throwIfAborted(input.signal);
    const result = await input.runner({
      timeoutMs: input.timeoutMs,
      signal: input.signal,
      env: input.env,
    });
    if (result.code === NOT_FOUND_EXIT) {
      return check(
        "tailscale",
        "controller",
        "skipped",
        "tailscale_cli_missing",
        elapsed(),
        { reason: "cli_missing" },
        REMEDY.tailscale,
      );
    }
    if (result.code !== 0) {
      const combined = `${result.stdout}\n${result.stderr}`.toLowerCase();
      const denied =
        /permission denied|access denied|failed to connect|tailscaled|daemon/.test(combined);
      return check(
        "tailscale",
        "controller",
        "skipped",
        denied ? "tailscale_daemon_unavailable" : "tailscale_cli_missing",
        elapsed(),
        { exit: result.code },
        REMEDY.tailscale,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      return check(
        "tailscale",
        "controller",
        "skipped",
        "tailscale_unmappable",
        elapsed(),
        { reason: "invalid_json" },
        REMEDY.tailscale,
      );
    }
    if (!parsed || typeof parsed !== "object") {
      return check(
        "tailscale",
        "controller",
        "skipped",
        "tailscale_unmappable",
        elapsed(),
        { reason: "invalid_status" },
        REMEDY.tailscale,
      );
    }
    const status = parsed as Record<string, unknown>;
    const peers: TailscalePeer[] = [];
    const self = peerFromStatus(status.Self);
    if (self) peers.push(self);
    if (status.Peer && typeof status.Peer === "object") {
      for (const value of Object.values(status.Peer as Record<string, unknown>)) {
        const peer = peerFromStatus(value);
        if (peer) peers.push(peer);
      }
    }
    const matched = matchPeer(peers, host);
    if (!matched) {
      return check(
        "tailscale",
        "controller",
        "skipped",
        "tailscale_peer_unknown",
        elapsed(),
        {
          reason: "no_exact_peer",
          host,
          note: "Never guessed from 127.0.0.1 or a 100.* prefix alone.",
        },
        REMEDY.tailscale,
      );
    }
    const online = matched.online === true;
    return check(
      "tailscale",
      "controller",
      online ? "ok" : "warn",
      online ? "tailscale_peer_online" : "tailscale_peer_offline",
      elapsed(),
      {
        hostName: matched.hostName ?? null,
        dnsName: matched.dnsName ?? null,
        online,
        tailscaleIPs: matched.tailscaleIPs ?? [],
        note: "Peer/online evidence does not prove SSH, forwarding, or app access.",
      },
      online ? null : "Tailscale reports the mapped peer offline; this is advisory and does not override SSH/hello/session checks.",
    );
  } catch (err) {
    if (err instanceof ZellijError && err.code === "cancelled") {
      throw err;
    }
    return check(
      "tailscale",
      "controller",
      "skipped",
      "tailscale_daemon_unavailable",
      elapsed(),
      { reason: err instanceof Error ? err.message : "tailscale_failed" },
      REMEDY.tailscale,
    );
  }
}

function busDisabled(env: NodeJS.ProcessEnv): boolean {
  const v = (env.ZSWARM_BUS ?? "").trim().toLowerCase();
  return v === "0" || v === "false" || v === "no" || v === "off";
}

/**
 * Passive host inspection. Safe reads only: binary/version via the client,
 * session listing, pane listing for an existing plugin pane, and StateStore
 * reads. Never pipes, launches, nudges, or writes markers.
 */
export async function inspectDoctorHost(input: HostInspectInput): Promise<HostInspectResult> {
  const checks: DoctorCheck[] = [];
  const budget = observationBudget(input.clock, Math.max(0, input.timeoutMs), input.signal);
  const started = () => input.clock.now();
  let cancelled = false;
  let timedOut = false;

  const markStop = (err: unknown): boolean => {
    const zerr = err instanceof ZellijError ? err : null;
    if (zerr?.code === "cancelled") {
      cancelled = true;
      return true;
    }
    if (zerr?.code === "observation_timeout" || zerr?.code === "timeout") {
      timedOut = true;
      return true;
    }
    return false;
  };

  const finishHost = (
    session: string | null,
    sessionOrigin: string,
  ): HostInspectResult => {
    const reason = cancelled ? "skipped_upstream" : timedOut ? "zellij_timeout" : "skipped_upstream";
    const remedy = timedOut
      ? "Doctor budget expired during host inspection."
      : cancelled
        ? null
        : REMEDY.zellij;
    checks.push(...skipHostChecks(checks, reason, remedy ?? REMEDY.zellij));
    return { checks, session, sessionOrigin, cancelled, timedOut };
  };

  try {
    budget.require();
  } catch (err) {
    if (markStop(err)) {
      const code = timedOut ? "zellij_timeout" : "zellij_cancelled";
      checks.push(
        check(
          "zellij_binary",
          "host",
          "skipped",
          code,
          0,
          { reason: timedOut ? "deadline_expired" : "cancelled" },
          timedOut ? "Doctor budget expired during host inspection." : null,
        ),
      );
      const resolvedEarly = sessionFromEnv(input.env, input.sessionArg);
      return finishHost(resolvedEarly?.session ?? null, originLabel(resolvedEarly?.source));
    }
    throw err;
  }

  if (input.busUnsupported) {
    const remedy = input.busRemedy ?? REMEDY.serve;
    checks.push(
      check(
        "bus_artifact",
        "host",
        "skipped",
        "bus_remote_unsupported",
        0,
        { reason: "direct_ssh" },
        remedy,
      ),
      check(
        "bus_marker",
        "host",
        "skipped",
        "bus_remote_unsupported",
        0,
        { reason: "direct_ssh" },
        remedy,
      ),
      check(
        "bus_instance",
        "host",
        "skipped",
        "bus_remote_unsupported",
        0,
        { reason: "direct_ssh", readiness: "unsupported" },
        remedy,
      ),
    );
  }

  let sessions: ZellijSession[] = [];
  let binaryOk = false;
  const binaryStarted = started();
  try {
    const left = budget.require();
    sessions = await input.client.listSessions(left, { fresh: true });
    binaryOk = true;
    checks.push(
      check(
        "zellij_binary",
        "host",
        "ok",
        "zellij_ok",
        elapsedSince(input.clock, binaryStarted),
        {
          zellij: input.client.zellijPath,
          transport: input.client.transport.kind,
        },
      ),
    );
  } catch (err) {
    const zerr = err instanceof ZellijError ? err : null;
    const code =
      zerr?.code === "zellij_missing"
        ? "zellij_missing"
        : zerr?.code === "zellij_wrong_bin"
          ? "zellij_wrong_bin"
          : zerr?.code === "zellij_incompatible"
            ? "zellij_incompatible"
            : zerr?.code === "cancelled"
              ? "zellij_cancelled"
              : zerr?.code === "observation_timeout"
                ? "zellij_timeout"
                : "zellij_unreachable";
    const sshish =
      zerr &&
      /permission denied|host key|could not resolve|connection refused|authentication/.test(
        zerr.message.toLowerCase(),
      );
    checks.push(
      check(
        "zellij_binary",
        "host",
        zerr?.code === "cancelled" || code === "zellij_timeout" ? "skipped" : "fail",
        sshish ? "zellij_unreachable" : code,
        elapsedSince(input.clock, binaryStarted),
        { message: zerr?.message ?? (err instanceof Error ? err.message : String(err)) },
        REMEDY.zellij,
      ),
    );
    if (markStop(err)) {
      const resolvedEarly = sessionFromEnv(input.env, input.sessionArg);
      return finishHost(resolvedEarly?.session ?? null, originLabel(resolvedEarly?.source));
    }
  }

  const ipcStarted = started();
  const ipc = input.client.transport.ipc;
  if (!binaryOk) {
    checks.push(
      check(
        "zellij_ipc",
        "host",
        "skipped",
        "ipc_skipped_upstream",
        elapsedSince(input.clock, ipcStarted),
        {},
        REMEDY.ipc,
      ),
    );
  } else if (input.client.transport.kind === "local") {
    checks.push(
      check(
        "zellij_ipc",
        "host",
        "ok",
        "ipc_local",
        elapsedSince(input.clock, ipcStarted),
        { transport: "local" },
      ),
    );
  } else if (!ipc || ipc.status === "none" || ipc.status === "skipped") {
    checks.push(
      check(
        "zellij_ipc",
        "host",
        "warn",
        "ipc_unresolved",
        elapsedSince(input.clock, ipcStarted),
        { requested: ipc?.requested ?? null, status: ipc?.status ?? "none" },
        REMEDY.ipc,
      ),
    );
  } else if (ipc.status === "resolved") {
    checks.push(
      check(
        "zellij_ipc",
        "host",
        "ok",
        "ipc_ok",
        elapsedSince(input.clock, ipcStarted),
        { requested: ipc.requested ?? null, tmp: ipc.tmp ?? null, status: ipc.status },
      ),
    );
  } else {
    checks.push(
      check(
        "zellij_ipc",
        "host",
        "fail",
        "ipc_failed",
        elapsedSince(input.clock, ipcStarted),
        { requested: ipc.requested ?? null, status: ipc.status },
        REMEDY.ipc,
      ),
    );
  }

  const listed = liveSessionNames(sessions);
  const sessionsStarted = started();
  if (!binaryOk) {
    checks.push(
      check(
        "zellij_sessions",
        "host",
        "skipped",
        "sessions_skipped_upstream",
        elapsedSince(input.clock, sessionsStarted),
        {},
        REMEDY.session,
      ),
    );
  } else if (listed.length === 0) {
    checks.push(
      check(
        "zellij_sessions",
        "host",
        "warn",
        "sessions_none",
        elapsedSince(input.clock, sessionsStarted),
        { live: [], exited: sessions.filter((row) => row.exited).map((row) => row.name) },
        REMEDY.session,
      ),
    );
  } else {
    checks.push(
      check(
        "zellij_sessions",
        "host",
        "ok",
        "sessions_visible",
        elapsedSince(input.clock, sessionsStarted),
        { live: listed },
      ),
    );
  }

  const resolved: ZellijSessionResolve | null = sessionFromEnv(
    input.env,
    input.sessionArg,
  );
  const sessionStarted = started();
  let session: string | null = resolved?.session ?? null;
  let sessionOrigin = originLabel(resolved?.source);
  if (!binaryOk) {
    checks.push(
      check(
        "session",
        "host",
        "skipped",
        "session_skipped_upstream",
        elapsedSince(input.clock, sessionStarted),
        { requested: session },
        REMEDY.session,
      ),
    );
  } else if (session) {
    const live = listed.includes(session);
    const exited = sessions.some((row) => row.name === session && row.exited);
    checks.push(
      check(
        "session",
        "host",
        live ? "ok" : "fail",
        live ? "session_present" : "session_missing",
        elapsedSince(input.clock, sessionStarted),
        { session, origin: sessionOrigin, exited },
        live ? null : REMEDY.session,
      ),
    );
  } else if (listed.length === 1) {
    session = listed[0]!;
    sessionOrigin = "host_default";
    checks.push(
      check(
        "session",
        "host",
        "ok",
        "session_present",
        elapsedSince(input.clock, sessionStarted),
        { session, origin: sessionOrigin },
      ),
    );
  } else {
    checks.push(
      check(
        "session",
        "host",
        listed.length === 0 ? "warn" : "warn",
        listed.length === 0 ? "session_unresolved" : "session_unresolved",
        elapsedSince(input.clock, sessionStarted),
        { live: listed, origin: "unresolved" },
        listed.length === 0 ? REMEDY.session : "Pass --session; multiple live sessions are present.",
      ),
    );
    sessionOrigin = "unresolved";
  }

  if (!input.busUnsupported) {
    const artifactStarted = started();
    const plugin = resolveBusPlugin(input.env);
    const explicit = (input.env.ZSWARM_BUS_PLUGIN ?? "").trim();
    if (plugin && existsSync(plugin)) {
      checks.push(
        check(
          "bus_artifact",
          "host",
          "ok",
          "bus_artifact_present",
          elapsedSince(input.clock, artifactStarted),
          { plugin },
        ),
      );
    } else {
      checks.push(
        check(
          "bus_artifact",
          "host",
          "warn",
          "bus_artifact_missing",
          elapsedSince(input.clock, artifactStarted),
          { configured: explicit || null },
          "Missing wasm is degraded performance, not an unusable crew. Build or set ZSWARM_BUS_PLUGIN on the crew host.",
        ),
      );
    }

    const markerStarted = started();
    if (!session) {
      checks.push(
        check(
          "bus_marker",
          "host",
          "skipped",
          "bus_marker_no_session",
          elapsedSince(input.clock, markerStarted),
          {},
          "Install the bus per session after a live crew session exists.",
        ),
      );
      checks.push(
        check(
          "bus_instance",
          "host",
          "skipped",
          "bus_instance_no_session",
          0,
          { readiness: "unknown" },
          "Bus readiness stays unknown until a session can be listed without launching a plugin.",
        ),
      );
    } else {
      const marker = input.state.readBus(session);
      if (!marker) {
        checks.push(
          check(
            "bus_marker",
            "host",
            "warn",
            "bus_marker_missing",
            elapsedSince(input.clock, markerStarted),
            { session },
            'Bus is not installed for this session; run zswarm bus --install on the crew host.',
          ),
        );
      } else if (!existsSync(marker.plugin)) {
        checks.push(
          check(
            "bus_marker",
            "host",
            "warn",
            "bus_marker_stale",
            elapsedSince(input.clock, markerStarted),
            { session, plugin: marker.plugin, installedAt: marker.installedAt },
            "The install marker names a wasm that is no longer present. Reinstall the bus on the crew host.",
          ),
        );
      } else {
        checks.push(
          check(
            "bus_marker",
            "host",
            "ok",
            "bus_marker_present",
            elapsedSince(input.clock, markerStarted),
            { session, plugin: marker.plugin, installedAt: marker.installedAt },
          ),
        );
      }

      const instanceStarted = started();
      if (busDisabled(input.env)) {
        checks.push(
          check(
            "bus_instance",
            "host",
            "skipped",
            "bus_disabled",
            elapsedSince(input.clock, instanceStarted),
            { readiness: "disabled", policy: "ZSWARM_BUS=0" },
            "Host policy disabled the bus (ZSWARM_BUS=0).",
          ),
        );
      } else if (!binaryOk) {
        checks.push(
          check(
            "bus_instance",
            "host",
            "skipped",
            "bus_instance_skipped_upstream",
            elapsedSince(input.clock, instanceStarted),
            { readiness: "unknown" },
            null,
          ),
        );
      } else {
        try {
          const panes = await input.client.listPanes(session, budget.require(), {
            fresh: true,
          });
          const pluginPath = marker && existsSync(marker.plugin) ? marker.plugin : plugin;
          const live = panes.filter((pane) => isBusPluginPane(pane, pluginPath));
          checks.push(
            check(
              "bus_instance",
              "host",
              live.length > 0 ? "ok" : "warn",
              live.length > 0 ? "bus_instance_observed" : "bus_instance_absent",
              elapsedSince(input.clock, instanceStarted),
              {
                session,
                instances: live.map((pane) => pane.id),
                readiness: "unknown",
                note: "Readiness is unknown: doctor does not pipe to the plugin or nudge panes.",
              },
              live.length > 0
                ? null
                : "No live bus plugin pane was observed. Missing/unready bus is degraded performance; doctor will not launch one.",
            ),
          );
        } catch (err) {
          if (markStop(err)) {
            checks.push(
              check(
                "bus_instance",
                "host",
                "skipped",
                timedOut ? "zellij_timeout" : "zellij_cancelled",
                elapsedSince(input.clock, instanceStarted),
                { readiness: "unknown", reason: timedOut ? "deadline_expired" : "cancelled" },
                timedOut ? "Doctor budget expired during host inspection." : null,
              ),
            );
            return finishHost(session, sessionOrigin);
          }
          checks.push(
            check(
              "bus_instance",
              "host",
              "warn",
              "bus_readiness_unknown",
              elapsedSince(input.clock, instanceStarted),
              {
                readiness: "unknown",
                message: err instanceof Error ? err.message : String(err),
              },
              "Could not list panes to observe a bus instance. Silence does not mean permissions are pending.",
            ),
          );
        }
      }
    }
  }

  return { checks, session, sessionOrigin, cancelled, timedOut };
}

function hostDoctorRequest(
  remainingMs: number,
  explicitSession: string | null,
): Record<string, unknown> {
  const request: Record<string, unknown> = {
    op: "doctor",
    [DOCTOR_SCOPE_FIELD]: DOCTOR_SCOPE_HOST,
    timeoutMs: Math.max(1, remainingMs),
  };
  if (explicitSession) request.session = explicitSession;
  return request;
}

function asDoctorCheck(value: unknown): DoctorCheck | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || row.id.trim() === "") return null;
  if (row.scope !== "controller" && row.scope !== "host") return null;
  if (row.state !== "ok" && row.state !== "warn" && row.state !== "fail" && row.state !== "skipped") {
    return null;
  }
  if (typeof row.code !== "string" || row.code.trim() === "") return null;
  const elapsedMs = typeof row.elapsedMs === "number" && Number.isFinite(row.elapsedMs) ? row.elapsedMs : 0;
  const detail =
    row.detail && typeof row.detail === "object" && !Array.isArray(row.detail)
      ? (row.detail as Record<string, unknown>)
      : {};
  const remedy = typeof row.remedy === "string" ? row.remedy : row.remedy === null ? null : null;
  return {
    id: row.id,
    scope: row.scope,
    state: row.state,
    code: row.code,
    elapsedMs,
    detail,
    remedy,
  };
}

function reportFromUnknown(value: unknown): DoctorReport | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const routeRaw = row.route;
  const checksRaw = row.checks;
  if (!routeRaw || typeof routeRaw !== "object" || Array.isArray(routeRaw) || !Array.isArray(checksRaw)) {
    return null;
  }
  const routeRow = routeRaw as Record<string, unknown>;
  if (routeRow.transport !== "local" && routeRow.transport !== "ssh" && routeRow.transport !== "serve") {
    return null;
  }
  const checks: DoctorCheck[] = [];
  for (const item of checksRaw) {
    const parsed = asDoctorCheck(item);
    if (!parsed) return null;
    checks.push(parsed);
  }
  const endpoint = typeof routeRow.endpoint === "string" ? routeRow.endpoint : "";
  const session = typeof routeRow.session === "string" ? routeRow.session : routeRow.session === null ? null : null;
  const sessionOrigin = typeof routeRow.sessionOrigin === "string" ? routeRow.sessionOrigin : "unresolved";
  return {
    route: {
      transport: routeRow.transport,
      endpoint,
      session,
      sessionOrigin,
    },
    checks,
  };
}

function hostChecksFrom(report: DoctorReport): DoctorCheck[] {
  return report.checks.filter((item) => item.scope === "host");
}

function hostSessionCovers(checks: DoctorCheck[], explicit: string | null): boolean {
  const row = checks.find((item) => item.id === "session");
  if (!row) return false;
  if (!explicit) return true;
  const named = [row.detail.session, row.detail.requested].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  return named.includes(explicit);
}

function hostRequestFailure(result: OpsResult): { code: string; remedy: string; detail: Record<string, unknown> } {
  const failed = serveFailure(result);
  const mapped =
    failed.code === "serve_unauthorized"
      ? "host_request_unauthorized"
      : failed.code === "serve_connect"
        ? "host_request_connect"
        : failed.code === "serve_timeout"
          ? "host_request_timeout"
          : failed.code === "serve_cancelled"
            ? "host_request_cancelled"
            : "host_request_protocol";
  return { code: mapped, remedy: failed.remedy, detail: failed.detail };
}

function failReachedHostLayer(
  existing: DoctorCheck[],
  code: string,
  remedy: string,
  detail: Record<string, unknown> = {},
): DoctorCheck[] {
  const extra: DoctorCheck[] = [];
  if (!existing.some((item) => item.id === "zellij_binary")) {
    extra.push(check("zellij_binary", "host", "fail", code, 0, detail, remedy));
  }
  extra.push(...skipHostChecks([...existing, ...extra], "skipped_upstream", remedy));
  return extra;
}

function coverHostReport(
  checks: DoctorCheck[],
  explicit: string | null,
): DoctorCheck[] {
  const out = [...checks];
  if (!out.some((item) => item.id === "zellij_binary")) {
    out.push(
      check(
        "zellij_binary",
        "host",
        "fail",
        HOST_REPORT_INCOMPLETE_CODE,
        0,
        { missing: "zellij_binary" },
        REMEDY.hostReport,
      ),
    );
  }
  const sessionRow = out.find((item) => item.id === "session");
  if (!sessionRow || !hostSessionCovers(out, explicit)) {
    const replacement = check(
      "session",
      "host",
      "fail",
      HOST_REPORT_INCOMPLETE_CODE,
      0,
      { requested: explicit, reason: sessionRow ? "session_not_covered" : "session_missing_from_report" },
      REMEDY.hostReport,
    );
    const idx = out.findIndex((item) => item.id === "session");
    if (idx >= 0) out[idx] = replacement;
    else out.push(replacement);
  }
  out.push(...skipHostChecks(out, "skipped_upstream", REMEDY.hostReport));
  return out;
}

function mergeHostReply(result: OpsResult): {
  checks: DoctorCheck[];
  session?: string | null;
  sessionOrigin?: string;
  unsupported?: boolean;
  invalid?: boolean;
} {
  if (!result.ok && (result.error.code === "usage" || /requires op=/.test(result.error.message))) {
    return { checks: [], unsupported: true };
  }
  const raw = result.ok ? result.data : result.error.details;
  const report = reportFromUnknown(raw);
  if (result.ok) {
    if (!report) return { checks: [], invalid: true };
    const checks = hostChecksFrom(report);
    if (checks.length === 0) return { checks: [], invalid: true, session: report.route.session, sessionOrigin: report.route.sessionOrigin };
    return {
      checks,
      session: report.route.session,
      sessionOrigin: report.route.sessionOrigin,
    };
  }
  if (result.error.code === DOCTOR_FAILED_CODE) {
    if (!report) return { checks: [], invalid: true };
    const checks = hostChecksFrom(report);
    if (checks.length === 0) {
      return { checks: [], invalid: true, session: report.route.session, sessionOrigin: report.route.sessionOrigin };
    }
    return {
      checks,
      session: report.route.session,
      sessionOrigin: report.route.sessionOrigin,
    };
  }
  if (!report) return { checks: [] };
  return {
    checks: hostChecksFrom(report),
    session: report.route.session,
    sessionOrigin: report.route.sessionOrigin,
  };
}

async function hostDoctorInProcess(input: {
  args: Record<string, unknown>;
  injected: ZellijClient | undefined;
  deps: DispatchDeps;
  env: NodeJS.ProcessEnv;
  clock: Clock;
  timeoutMs: number;
  signal?: AbortSignal;
  busUnsupported?: boolean;
  /** Serve workers and local inspect must not recurse into SSH/serve. */
  stripRouting?: boolean;
}): Promise<HostInspectResult> {
  const hostEnv = input.stripRouting === false ? input.env : serveChildEnv(input.env);
  const client =
    input.injected ??
    createZellijClient({
      env: hostEnv,
      signal: input.signal,
      now: input.clock.now,
    });
  const state = input.deps.state ?? createStateStore({ env: hostEnv });
  return inspectDoctorHost({
    client,
    state,
    env: hostEnv,
    sessionArg: selectedSession(input.args),
    clock: input.clock,
    timeoutMs: input.timeoutMs,
    signal: input.signal,
    busUnsupported: input.busUnsupported,
    busRemedy: REMEDY.serve,
  });
}

function interactiveSsh(env: NodeJS.ProcessEnv): boolean {
  try {
    return validateSshMode(env.ZSWARM_SSH_MODE ?? "") === "interactive";
  } catch {
    return false;
  }
}

async function inspectDirectSsh(input: {
  args: Record<string, unknown>;
  injected: ZellijClient | undefined;
  deps: DispatchDeps;
  env: NodeJS.ProcessEnv;
  clock: Clock;
  remaining: () => number;
  signal?: AbortSignal;
  checks: DoctorCheck[];
  status: { cancelled: boolean; timedOut: boolean };
}): Promise<void> {
  const sshStarted = input.clock.now();
  if (interactiveSsh(input.env) && !input.injected) {
    input.checks.push(
      check(
        "ssh",
        "controller",
        "skipped",
        "ssh_interactive_uninspected",
        elapsedSince(input.clock, sshStarted),
        { mode: "interactive" },
        REMEDY.interactive,
      ),
      check("serve", "controller", "skipped", "serve_not_applicable", 0, {}, null),
      ...skipHostChecks(input.checks, "zellij_interactive_unsupported", REMEDY.interactive),
    );
    return;
  }
  try {
    throwIfAborted(input.signal);
    if (input.remaining() <= 0) {
      input.status.timedOut = true;
      input.checks.push(
        check("ssh", "controller", "fail", "ssh_timeout", elapsedSince(input.clock, sshStarted), {}, "SSH inspection ran out of doctor budget."),
      );
      input.checks.push(
        check("serve", "controller", "skipped", "serve_not_applicable", 0, {}, null),
        ...skipHostChecks(input.checks, "skipped_upstream", REMEDY.serve),
      );
      return;
    }
    const inspect = await hostDoctorInProcess({
      args: input.args,
      injected: input.injected,
      deps: input.deps,
      env: input.env,
      clock: input.clock,
      timeoutMs: input.remaining(),
      signal: input.signal,
      busUnsupported: true,
      stripRouting: false,
    });
    if (inspect.cancelled) {
      input.status.cancelled = true;
      input.checks.push(
        check("ssh", "controller", "skipped", "ssh_cancelled", elapsedSince(input.clock, sshStarted), {}, null),
        check("serve", "controller", "skipped", "serve_not_applicable", 0, {}, null),
        ...(inspect.checks.length ? inspect.checks : skipHostChecks(input.checks, "skipped_upstream", REMEDY.serve)),
      );
      return;
    }
    if (inspect.timedOut) {
      input.status.timedOut = true;
      const binaryOk = inspect.checks.some((item) => item.id === "zellij_binary" && item.state === "ok");
      input.checks.push(
        binaryOk
          ? check(
              "ssh",
              "controller",
              "ok",
              "ssh_ready",
              elapsedSince(input.clock, sshStarted),
              { destination: input.env.ZSWARM_SSH ?? null },
            )
          : check(
              "ssh",
              "controller",
              "fail",
              "ssh_timeout",
              elapsedSince(input.clock, sshStarted),
              {},
              "SSH inspection ran out of doctor budget.",
            ),
        check("serve", "controller", "skipped", "serve_not_applicable", 0, {}, null),
        ...(inspect.checks.length ? inspect.checks : skipHostChecks(input.checks, "skipped_upstream", REMEDY.serve)),
      );
      return;
    }
    const binary = inspect.checks.find((item) => item.id === "zellij_binary");
    const sshish =
      binary?.state === "fail" &&
      /permission denied|host key|authentication|could not resolve|connection refused/.test(
        String(binary.detail.message ?? "").toLowerCase(),
      );
    if (sshish) {
      const classified = sshFailure(String(binary.detail.message ?? ""));
      input.checks.push(
        check(
          "ssh",
          "controller",
          "fail",
          classified.code,
          elapsedSince(input.clock, sshStarted),
          binary?.detail ?? {},
          classified.remedy,
        ),
        check("serve", "controller", "skipped", "serve_not_applicable", 0, {}, null),
        ...inspect.checks,
      );
      return;
    }
    input.checks.push(
      check(
        "ssh",
        "controller",
        "ok",
        "ssh_ready",
        elapsedSince(input.clock, sshStarted),
        { destination: input.env.ZSWARM_SSH ?? null },
      ),
      check("serve", "controller", "skipped", "serve_not_applicable", 0, {}, null),
      ...inspect.checks,
    );
  } catch (err) {
    if (err instanceof ZellijError && err.code === "cancelled") {
      input.status.cancelled = true;
      input.checks.push(
        check("ssh", "controller", "skipped", "ssh_cancelled", elapsedSince(input.clock, sshStarted), {}, null),
        check("serve", "controller", "skipped", "serve_not_applicable", 0, {}, null),
        ...skipHostChecks(input.checks, "skipped_upstream", REMEDY.serve),
      );
      return;
    }
    if (err instanceof ZellijError && (err.code === "timeout" || err.code === "observation_timeout")) {
      input.status.timedOut = true;
      input.checks.push(
        check("ssh", "controller", "fail", "ssh_timeout", elapsedSince(input.clock, sshStarted), {}, "SSH inspection ran out of doctor budget."),
        check("serve", "controller", "skipped", "serve_not_applicable", 0, {}, null),
        ...skipHostChecks(input.checks, "skipped_upstream", REMEDY.serve),
      );
      return;
    }
    if (err instanceof ZellijError && (err.code === "usage" || err.code === "bad_arg" || err.code === "bad_ssh" || err.code === "bad_ssh_mode")) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    const classified = sshFailure(message);
    input.checks.push(
      check(
        "ssh",
        "controller",
        "fail",
        classified.code,
        elapsedSince(input.clock, sshStarted),
        { message },
        classified.remedy,
      ),
      check("serve", "controller", "skipped", "serve_not_applicable", 0, {}, null),
      ...skipHostChecks(input.checks, "skipped_upstream", classified.remedy),
    );
  }
}

async function inspectServeRoute(input: {
  args: Record<string, unknown>;
  deps: DispatchDeps;
  env: NodeJS.ProcessEnv;
  clock: Clock;
  remaining: () => number;
  signal?: AbortSignal;
  target: string;
  checks: DoctorCheck[];
  report: DoctorReport;
  status: { cancelled: boolean; timedOut: boolean };
}): Promise<void> {
  const sshTarget = isSshServeTarget(input.target);
  let manager: ServeTunnelManager | undefined = input.deps.serveTunnels;
  let ownedManager: ServeTunnelManager | undefined;
  let handle: ServeTunnelHandle | undefined;
  let endpoint = input.target;
  const token = input.env.ZSWARM_SERVE_TOKEN;
  const explicit = selectedSession(input.args);

  const releaseOwned = async () => {
    try {
      await handle?.release();
    } finally {
      handle = undefined;
      if (ownedManager) {
        await ownedManager.closeAll();
        ownedManager = undefined;
      }
    }
  };

  try {
    if (sshTarget) {
      const sshStarted = input.clock.now();
      if (!manager) {
        ownedManager = createServeTunnelManager({
          persistIdle: false,
          now: input.clock.now,
          sleep: input.clock.sleep,
        });
        manager = ownedManager;
      }
      if (input.remaining() <= 0) {
        input.status.timedOut = true;
        input.checks.push(
          check("ssh", "controller", "fail", "ssh_timeout", elapsedSince(input.clock, sshStarted), {}, "SSH LocalForward ran out of doctor budget."),
          check("serve", "controller", "skipped", "serve_skipped_upstream", 0, {}, REMEDY.serve),
          ...skipHostChecks(input.checks, "skipped_upstream", REMEDY.serve),
        );
        return;
      }
      const acquired = await manager.acquire(input.target, {
        env: input.env,
        token,
        timeoutMs: input.remaining(),
        signal: input.signal,
      });
      if (!("handle" in acquired) || acquired.ok !== true) {
        const err = acquired as OpsResult;
        const message = err.ok ? "ssh tunnel failed" : err.error.message;
        const code = err.ok ? "serve_unreachable" : err.error.code;
        if (code === "cancelled") {
          input.status.cancelled = true;
          input.checks.push(
            check("ssh", "controller", "skipped", "ssh_cancelled", elapsedSince(input.clock, sshStarted), { message }, null),
            check("serve", "controller", "skipped", "serve_skipped_upstream", 0, {}, REMEDY.serve),
            ...skipHostChecks(input.checks, "skipped_upstream", REMEDY.serve),
          );
          return;
        }
        if (code === "timeout") {
          input.status.timedOut = true;
          input.checks.push(
            check("ssh", "controller", "fail", "ssh_timeout", elapsedSince(input.clock, sshStarted), { message }, "SSH LocalForward timed out inside the doctor budget."),
            check("serve", "controller", "skipped", "serve_skipped_upstream", 0, {}, REMEDY.serve),
            ...skipHostChecks(input.checks, "skipped_upstream", REMEDY.serve),
          );
          return;
        }
        if (
          code === "serve_unauthorized" ||
          code === "serve_hello_unsupported" ||
          code === "serve_incompatible" ||
          code === "serve_protocol"
        ) {
          input.checks.push(
            check(
              "ssh",
              "controller",
              "ok",
              "ssh_ready",
              elapsedSince(input.clock, sshStarted),
              { destination: describeServeTarget(input.target) },
            ),
          );
          const failed = serveFailure(err);
          input.checks.push(
            check("serve", "controller", "fail", failed.code, 0, failed.detail, failed.remedy),
            ...skipHostChecks(input.checks, "skipped_upstream", failed.remedy),
          );
          return;
        }
        const classified = sshFailure(message);
        input.checks.push(
          check(
            "ssh",
            "controller",
            "fail",
            classified.code,
            elapsedSince(input.clock, sshStarted),
            { message, transportCode: code },
            classified.remedy,
          ),
          check("serve", "controller", "skipped", "serve_skipped_upstream", 0, {}, classified.remedy),
          ...skipHostChecks(input.checks, "skipped_upstream", classified.remedy),
        );
        return;
      }
      handle = acquired.handle;
      endpoint = acquired.localTarget;
      input.report.server = acquired.hello;
      input.checks.push(
        check(
          "ssh",
          "controller",
          "ok",
          "ssh_ready",
          elapsedSince(input.clock, sshStarted),
          {
            destination: acquired.handle.identity,
            localTarget: acquired.localTarget,
          },
        ),
      );
      input.checks.push(
        check(
          "serve",
          "controller",
          "ok",
          "serve_hello_ok",
          0,
          { ...acquired.hello, endpoint: acquired.localTarget },
        ),
      );
    } else {
      input.checks.push(
        check("ssh", "controller", "skipped", "ssh_not_applicable", 0, { endpoint: input.target }, null),
      );
      const helloStarted = input.clock.now();
      if (input.remaining() <= 0) {
        input.status.timedOut = true;
        input.checks.push(
          check("serve", "controller", "fail", "serve_timeout", elapsedSince(input.clock, helloStarted), {}, "Serve hello ran out of doctor budget."),
          ...skipHostChecks(input.checks, "skipped_upstream", REMEDY.serve),
        );
        return;
      }
      const probed = await probeServe(endpoint, {
        token,
        timeoutMs: input.remaining(),
        signal: input.signal,
      });
      if (!probed.ok) {
        if (probed.error.code === "cancelled") {
          input.status.cancelled = true;
          input.checks.push(
            check("serve", "controller", "skipped", "serve_cancelled", elapsedSince(input.clock, helloStarted), serveFailure(probed).detail, null),
            ...skipHostChecks(input.checks, "skipped_upstream", REMEDY.serve),
          );
          return;
        }
        if (probed.error.code === "timeout") {
          input.status.timedOut = true;
        }
        const failed = serveFailure(probed);
        input.checks.push(
          check(
            "serve",
            "controller",
            "fail",
            failed.code,
            elapsedSince(input.clock, helloStarted),
            failed.detail,
            failed.remedy,
          ),
          ...skipHostChecks(input.checks, "skipped_upstream", failed.remedy),
        );
        return;
      }
      input.report.server = probed.data as ServeHelloData;
      input.checks.push(
        check(
          "serve",
          "controller",
          "ok",
          "serve_hello_ok",
          elapsedSince(input.clock, helloStarted),
          { ...(probed.data as ServeHelloData), endpoint },
        ),
      );
    }

    if (input.status.cancelled || input.status.timedOut) return;
    if (input.remaining() <= 0) {
      input.status.timedOut = true;
      input.checks.push(...skipHostChecks(input.checks, "skipped_upstream", REMEDY.serve));
      return;
    }
    const hostResult = await callServe(
      endpoint,
      hostDoctorRequest(input.remaining(), explicit),
      {
        timeoutMs: Math.max(1, input.remaining()),
        token,
        signal: input.signal,
      },
    );
    const merged = mergeHostReply(hostResult);
    const adoptHostSession = () => {
      if (merged.session && input.report.route.sessionOrigin === "unresolved") {
        input.report.route.session = merged.session ?? null;
        if (merged.sessionOrigin) input.report.route.sessionOrigin = merged.sessionOrigin;
      }
      if (explicit && merged.sessionOrigin === "explicit") {
        input.report.route.session = merged.session ?? explicit;
        input.report.route.sessionOrigin = "explicit";
      }
    };
    if (!hostResult.ok && hostResult.error.code === "cancelled") {
      input.status.cancelled = true;
      input.checks.push(
        ...(merged.checks.length
          ? [...merged.checks, ...skipHostChecks([...input.checks, ...merged.checks], "skipped_upstream", REMEDY.serve)]
          : skipHostChecks(input.checks, "skipped_upstream", REMEDY.serve)),
      );
      adoptHostSession();
      return;
    }
    if (!hostResult.ok && hostResult.error.code === "timeout") {
      input.status.timedOut = true;
      input.checks.push(
        ...(merged.checks.length
          ? [...merged.checks, ...skipHostChecks([...input.checks, ...merged.checks], "skipped_upstream", REMEDY.serve)]
          : skipHostChecks(input.checks, "skipped_upstream", REMEDY.serve)),
      );
      adoptHostSession();
      return;
    }
    if (merged.unsupported) {
      input.checks.push(...skipHostChecks(input.checks, "doctor_unsupported", REMEDY.upgrade));
      return;
    }
    if (merged.invalid) {
      input.checks.push(
        ...failReachedHostLayer(input.checks, HOST_REPORT_INVALID_CODE, REMEDY.hostReport, {
          reason: "empty_or_malformed_host_report",
        }),
      );
      return;
    }
    if (!hostResult.ok && merged.checks.length === 0) {
      const failed = hostRequestFailure(hostResult);
      input.checks.push(...failReachedHostLayer(input.checks, failed.code, failed.remedy, failed.detail));
      return;
    }
    input.checks.push(...coverHostReport(merged.checks, explicit));
    adoptHostSession();
  } finally {
    await releaseOwned();
  }
}

/**
 * Inspect-only layered diagnostics. Handle this before ordinary serve
 * forwarding so a dead tunnel still reports controller findings.
 */
export async function doctorOp(
  args: Record<string, unknown>,
  injected: ZellijClient | undefined,
  deps: DispatchDeps,
  context: RoutingContext,
  env: NodeJS.ProcessEnv,
  clock: Clock,
): Promise<OpsResult> {
  const timeoutMs = numberArg(args, "timeoutMs", DEFAULT_DOCTOR_TIMEOUT_MS, {
    min: 1,
    max: 900_000,
  });
  const signal = deps.signal;
  const budget = observationBudget(clock, timeoutMs, signal);
  const remaining = () => {
    try {
      return budget.remaining();
    } catch (err) {
      if (err instanceof ZellijError && err.code === "cancelled") return 0;
      return 0;
    }
  };
  const status = { cancelled: false, timedOut: false };
  const hostOnly = args[DOCTOR_SCOPE_FIELD] === DOCTOR_SCOPE_HOST;
  const serveTarget = optionalString(env.ZSWARM_SERVE);
  const sshTarget = optionalString(env.ZSWARM_SSH);
  const routeTransport: DoctorRoute["transport"] = hostOnly
    ? "local"
    : serveTarget
      ? "serve"
      : sshTarget
        ? "ssh"
        : "local";
  const routeEndpoint = hostOnly
    ? hostname() || "local"
    : serveTarget
      ? describeServeTarget(serveTarget)
      : sshTarget ?? (hostname() || "local");
  const report: DoctorReport = {
    route: {
      transport: routeTransport,
      endpoint: routeEndpoint,
      session: hostOnly ? selectedSession(args) : context.session,
      sessionOrigin: hostOnly
        ? originLabel(sessionFromEnv(serveChildEnv(env), selectedSession(args))?.source)
        : controllerSessionOrigin(context),
    },
    checks: [],
  };

  const markStop = (err: unknown): boolean => {
    if (err instanceof ZellijError && err.code === "cancelled") {
      status.cancelled = true;
      return true;
    }
    if (err instanceof ZellijError && (err.code === "timeout" || err.code === "observation_timeout")) {
      status.timedOut = true;
      return true;
    }
    return false;
  };

  try {
    throwIfAborted(signal);
    if (hostOnly) {
      if (remaining() <= 0) {
        if (signal?.aborted) status.cancelled = true;
        else if (!status.cancelled) status.timedOut = true;
        report.checks.push(...skipHostChecks(report.checks, "skipped_upstream", REMEDY.zellij));
        return finishReport(report, status);
      }
      const inspect = await hostDoctorInProcess({
        args,
        injected,
        deps,
        env,
        clock,
        timeoutMs: remaining(),
        signal,
      });
      if (inspect.cancelled) status.cancelled = true;
      if (inspect.timedOut) status.timedOut = true;
      report.route.session = inspect.session;
      report.route.sessionOrigin = inspect.sessionOrigin;
      report.checks.push(...inspect.checks);
      return finishReport(report, status);
    }

    report.checks.push(
      check(
        "route",
        "controller",
        "ok",
        "route_selected",
        0,
        {
          transport: report.route.transport,
          endpoint: report.route.endpoint,
          session: report.route.session,
          sessionOrigin: report.route.sessionOrigin,
          origin: context.origin,
          note:
            report.route.transport === "serve" && isLoopbackEndpoint(report.route.endpoint)
              ? "Loopback is the tunnel endpoint, not the crew host."
              : null,
        },
      ),
    );

    const tailscaleBudget = Math.min(
      DOCTOR_TAILSCALE_MAX_MS,
      Math.max(0, timeoutMs - DOCTOR_TAILSCALE_RESERVE_MS),
      remaining(),
    );
    const tailscaleRunner = deps.tailscaleStatus ?? defaultTailscaleStatus;
    try {
      report.checks.push(
        await inspectTailscale({
          route: report.route,
          env,
          clock,
          timeoutMs: tailscaleBudget,
          signal,
          runner: tailscaleRunner,
        }),
      );
    } catch (err) {
      if (!markStop(err)) throw err;
      report.checks.push(
        check("tailscale", "controller", "skipped", "tailscale_skipped", 0, { reason: "cancelled" }, REMEDY.tailscale),
      );
    }

    if (status.cancelled || status.timedOut || remaining() <= 0) {
      if (remaining() <= 0 && !status.cancelled) status.timedOut = true;
      if (routeTransport === "serve") {
        if (!reportHas(report.checks, "ssh")) {
          report.checks.push(
            check(
              "ssh",
              "controller",
              "skipped",
              isSshServeTarget(env.ZSWARM_SERVE ?? "") ? "ssh_skipped_upstream" : "ssh_not_applicable",
              0,
              {},
              null,
            ),
          );
        }
        if (!reportHas(report.checks, "serve")) {
          report.checks.push(
            check("serve", "controller", "skipped", "serve_skipped_upstream", 0, {}, REMEDY.serve),
          );
        }
      } else if (routeTransport === "ssh") {
        if (!reportHas(report.checks, "ssh")) {
          report.checks.push(check("ssh", "controller", "skipped", "ssh_skipped_upstream", 0, {}, REMEDY.serve));
        }
      }
      if (!HOST_CHECK_IDS.every((id) => reportHas(report.checks, id))) {
        report.checks.push(...skipHostChecks(report.checks, "skipped_upstream", REMEDY.serve));
      }
      return finishReport(report, status);
    }

    if (routeTransport === "ssh") {
      await inspectDirectSsh({
        args,
        injected,
        deps,
        env,
        clock,
        remaining,
        signal,
        checks: report.checks,
        status,
      });
      if (status.cancelled || status.timedOut) return finishReport(report, status);
    } else if (routeTransport === "serve") {
      const target = env.ZSWARM_SERVE?.trim();
      if (!target) {
        report.checks.push(
          check("ssh", "controller", "skipped", "ssh_not_applicable", 0, {}, null),
          check(
            "serve",
            "controller",
            "fail",
            "serve_connect",
            0,
            { reason: "missing_target" },
            REMEDY.serve,
          ),
          ...skipHostChecks(report.checks, "skipped_upstream", REMEDY.serve),
        );
      } else {
        await inspectServeRoute({
          args,
          deps,
          env,
          clock,
          remaining,
          signal,
          target,
          checks: report.checks,
          report,
          status,
        });
      }
    } else {
      report.checks.push(
        check("ssh", "controller", "skipped", "ssh_not_applicable", 0, {}, null),
        check("serve", "controller", "skipped", "serve_not_applicable", 0, {}, null),
      );
      const inspect = await hostDoctorInProcess({
        args,
        injected,
        deps,
        env,
        clock,
        timeoutMs: remaining(),
        signal,
      });
      if (inspect.cancelled) status.cancelled = true;
      if (inspect.timedOut) status.timedOut = true;
      report.route.session = inspect.session ?? report.route.session;
      if (inspect.sessionOrigin !== "unresolved" && report.route.sessionOrigin === "unresolved") {
        report.route.sessionOrigin = inspect.sessionOrigin;
      }
      if (inspect.session && report.route.sessionOrigin === "explicit") {
        report.route.session = inspect.session;
      }
      report.checks.push(...inspect.checks);
    }

    return finishReport(report, status);
  } catch (err) {
    if (err instanceof ZellijError && (err.code === "usage" || err.code === "bad_arg" || err.code === "bad_ssh" || err.code === "bad_ssh_mode" || err.code === "policy_denied")) {
      return { ok: false, error: { code: err.code, message: err.message } };
    }
    if (markStop(err)) {
      if (!HOST_CHECK_IDS.every((id) => reportHas(report.checks, id))) {
        report.checks.push(...skipHostChecks(report.checks, "skipped_upstream", REMEDY.serve));
      }
      return finishReport(report, status);
    }
    throw err;
  }
}
