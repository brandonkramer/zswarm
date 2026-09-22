import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { ZellijError } from "../errors.js";
import { createStateStore, type StateStore } from "../state.js";
import { createZellijClient, type ZellijClient } from "../zellij/client.js";
import { isBusPluginPane, resolveBusPlugin } from "../zellij/bus.js";
import {
  liveSessionNames,
  sessionFromEnv,
  type ZellijSession,
} from "../zellij/session.js";
import { validateSshMode } from "../zellij/binary.js";
import type { Clock, DispatchDeps, OpsResult } from "./types.js";
import type { RoutingContext } from "./routing.js";
import {
  callServe,
  isLoopbackHost,
  parseListenAddress,
  probeServe,
  SERVE_CAPABILITY_DOCTOR,
  type ServeHelloData,
} from "./serve.js";
import {
  createServeTunnelManager,
  describeServeTarget,
  isSshServeTarget,
  parseSshServeTarget,
  stripControllerRouting,
} from "./serve-tunnel.js";
import { numberArg, optionalString, throwIfAborted } from "./util.js";

/** Default overall doctor deadline. Optional Tailscale cannot consume this. */
export const DEFAULT_DOCTOR_TIMEOUT_MS = 10_000;
/** Internal serve payload: host-local inspection only. Not a routing field. */
export const DOCTOR_HOST_INSPECT_FIELD = "doctorInspect";
export const DOCTOR_HOST_INSPECT_VALUE = "host";

export const TAILSCALE_MAX_MS = 1_500;
export const TAILSCALE_MAX_BYTES = 256 * 1024;
const TAILSCALE_JSON_FLAG = "--json";

export type DoctorCheckState = "ok" | "warn" | "fail" | "skipped";
export type DoctorCheckScope = "controller" | "host";

export type DoctorCheck = {
  id: string;
  scope: DoctorCheckScope;
  state: DoctorCheckState;
  code: string;
  elapsedMs: number;
  detail: string;
  remedy: string;
};

export type DoctorRoute = {
  transport: "local" | "ssh" | "serve";
  target: string;
  session: string | null;
  sessionOrigin: string;
  selector: string;
  loopbackTunnel: boolean;
};

export type DoctorReport = {
  route: DoctorRoute;
  server?: {
    hostname: string;
    platform: string;
    version: string;
    protocol: number;
    serverId: string;
    capabilities: string[];
  };
  checks: DoctorCheck[];
};

export type InspectHostCrewInput = {
  env: NodeJS.ProcessEnv;
  clock: Clock;
  signal?: AbortSignal;
  deadlineAt: number;
  /** Explicit session argument only; host env supplies inherited defaults. */
  explicitSession?: string | null;
  client?: ZellijClient;
  state?: StateStore;
  /** Direct SSH cannot treat controller bus files as host facts. */
  bus: "host" | "unsupported_ssh";
  /**
   * Interactive SSH would create Windows scheduled tasks / temp IPC files.
   * Doctor must not invoke that path; required session is not healthy.
   */
  sshInteractive?: boolean;
};

const HOST_CHECK_IDS = [
  "zellij",
  "ipc",
  "sessions",
  "session",
  "bus_artifact",
  "bus_marker",
  "bus_instance",
] as const;

const REQUIRED_IDS = new Set(["route", "serve", "ssh", "zellij", "session"]);

const SERVE_REMEDY =
  "Run `zswarm serve --listen` next to Zellij on the crew host (OpenSSH over Tailscale to that loopback). Direct SSH interactive inspection is not used by doctor.";

const MACOS_TAILSCALE = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

export function isDoctorReport(value: unknown): value is DoctorReport {
  if (!value || typeof value !== "object") return false;
  const v = value as { route?: unknown; checks?: unknown };
  return Boolean(v.route && typeof v.route === "object" && Array.isArray(v.checks));
}

export function isDoctorRequiredCheck(check: DoctorCheck): boolean {
  if (!REQUIRED_IDS.has(check.id)) return false;
  if (check.state === "skipped") return false;
  return true;
}

function remainingMs(clock: Clock, deadlineAt: number): number {
  return Math.max(0, deadlineAt - clock.now());
}

function timedCheck(
  clock: Clock,
  id: string,
  scope: DoctorCheckScope,
  started: number,
  state: DoctorCheckState,
  code: string,
  detail: string,
  remedy: string,
): DoctorCheck {
  return {
    id,
    scope,
    state,
    code,
    elapsedMs: Math.max(0, clock.now() - started),
    detail,
    remedy,
  };
}

function skipped(
  id: string,
  scope: DoctorCheckScope,
  code: string,
  detail: string,
  remedy = "",
): DoctorCheck {
  return { id, scope, state: "skipped", code, elapsedMs: 0, detail, remedy };
}

function skipHostRest(
  checks: DoctorCheck[],
  code: string,
  detail: string,
  remedy = "",
): void {
  const have = new Set(checks.map((c) => c.id));
  for (const id of HOST_CHECK_IDS) {
    if (!have.has(id)) checks.push(skipped(id, "host", code, detail, remedy));
  }
}

function sessionOriginLabel(source: string | undefined): string {
  if (source === "arg") return "explicit";
  if (source === "env_zswarm" || source === "env_zellij") return "inherited";
  if (source === "sole_live") return "host_default";
  if (source === "server") return "server";
  return source?.trim() || "unresolved";
}

function selectedSession(env: NodeJS.ProcessEnv, explicit?: string | null) {
  return sessionFromEnv(env, explicit);
}

export function classifySshFailure(message: string): {
  code: string;
  stage: string;
  remedy: string;
} | null {
  const text = message.toLowerCase();
  if (
    /host key verification failed/.test(text) ||
    /remote host identification has changed/.test(text) ||
    /not in the list of known hosts/.test(text)
  ) {
    return {
      code: "ssh_host_key",
      stage: "host-key",
      remedy:
        "Verify the SSH host key for this destination (known_hosts). Doctor does not change host keys.",
    };
  }
  if (
    /permission denied/.test(text) ||
    /authentication failed/.test(text) ||
    /too many authentication failures/.test(text) ||
    /no more authentication methods/.test(text)
  ) {
    return {
      code: "ssh_auth",
      stage: "auth",
      remedy:
        "Use an agent or key that can log in to this OpenSSH destination. Doctor does not change SSH config or run tailscale up.",
    };
  }
  if (
    /administratively prohibited/.test(text) ||
    /channel open failed/.test(text) ||
    /remote port forwarding failed/.test(text) ||
    /port forwarding failed/.test(text) ||
    /failed to bind/.test(text)
  ) {
    return {
      code: "ssh_forward",
      stage: "forward",
      remedy:
        "The SSH LocalForward did not become ready. Confirm remote serve is listening on loopback and OpenSSH allows that forward.",
    };
  }
  if (
    /could not resolve hostname/.test(text) ||
    /name or service not known/.test(text) ||
    /no route to host/.test(text) ||
    /network is unreachable/.test(text) ||
    /connection refused/.test(text) ||
    /connection timed out/.test(text) ||
    /operation timed out/.test(text) ||
    /connection reset/.test(text)
  ) {
    return {
      code: "ssh_connect",
      stage: "connect",
      remedy:
        "Confirm the OpenSSH destination is reachable over the network (Tailscale peer-online is not SSH proof).",
    };
  }
  return null;
}

function serveStageCheck(
  clock: Clock,
  started: number,
  result: OpsResult,
  sshUri: boolean,
): DoctorCheck {
  if (result.ok) {
    return timedCheck(
      clock,
      sshUri ? "serve" : "serve",
      "controller",
      started,
      "ok",
      "serve_ok",
      "Authenticated serve hello succeeded. A TCP connect alone is not readiness.",
      "",
    );
  }
  const err = result.error;
  const details = err.details as { phase?: string; remedy?: string; endpoint?: string } | undefined;
  const ssh = classifySshFailure(err.message);
  if (sshUri && ssh) {
    return timedCheck(
      clock,
      "serve",
      "controller",
      started,
      "fail",
      ssh.code,
      err.message,
      ssh.remedy,
    );
  }
  const code = err.code;
  const remedy =
    (typeof details?.remedy === "string" && details.remedy) ||
    (code === "serve_unauthorized"
      ? "Set the same ZSWARM_SERVE_TOKEN on the server and this caller."
      : code === "serve_hello_unsupported"
        ? "Upgrade zswarm serve so it speaks hello (protocol 1) and the doctor capability."
        : code === "serve_incompatible"
          ? "Upgrade zswarm on both sides to the same serve protocol."
          : "Check that zswarm serve is running beside Zellij. Doctor does not fall back to another route.");
  return timedCheck(
    clock,
    "serve",
    "controller",
    started,
    "fail",
    code,
    err.message,
    remedy,
  );
}

function peerKey(host: string): string {
  return host.trim().replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
}

function isCgnat100(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host.trim());
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a === 100 && b >= 64 && b <= 127;
}

function destinationHost(context: RoutingContext, env: NodeJS.ProcessEnv): string | null {
  if (context.transport === "local") return null;
  if (context.transport === "ssh") {
    const dest = optionalString(env.ZSWARM_SSH) ?? context.host;
    const at = dest.lastIndexOf("@");
    return at === -1 ? dest : dest.slice(at + 1);
  }
  const raw = optionalString(env.ZSWARM_SERVE);
  if (!raw) return null;
  if (isSshServeTarget(raw)) {
    try {
      return parseSshServeTarget(raw).host;
    } catch {
      return null;
    }
  }
  try {
    return parseListenAddress(raw).host;
  } catch {
    return null;
  }
}

type TailscalePeer = {
  HostName?: string;
  DNSName?: string;
  TailscaleIPs?: string[];
  Online?: boolean;
  Active?: boolean;
  Relay?: string;
};

function matchTailscalePeer(
  dest: string,
  status: { Self?: TailscalePeer; Peer?: Record<string, TailscalePeer> },
): { peer: TailscalePeer; how: string } | null {
  const host = peerKey(dest);
  if (!host || host === "localhost" || isLoopbackHost(host)) return null;
  const candidates: TailscalePeer[] = [
    ...(status.Self ? [status.Self] : []),
    ...Object.values(status.Peer ?? {}),
  ];
  const names = (peer: TailscalePeer): string[] => {
    const out = [peer.HostName, peer.DNSName]
      .filter((s): s is string => typeof s === "string" && s.trim() !== "")
      .map(peerKey);
    return out;
  };
  for (const peer of candidates) {
    if (names(peer).includes(host)) {
      return { peer, how: "name" };
    }
    const dns = peerKey(peer.DNSName ?? "");
    if (dns && (dns.startsWith(`${host}.`) || dns === host)) {
      return { peer, how: "name" };
    }
  }
  // Exact address evidence only — never guess a peer from a 100.* prefix.
  if (isCgnat100(host) || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")) {
    for (const peer of candidates) {
      const ips = (peer.TailscaleIPs ?? []).map((ip) => ip.replace(/^\[|\]$/g, "").toLowerCase());
      if (ips.includes(host)) return { peer, how: "address" };
    }
  }
  return null;
}

function tailscaleBins(env: NodeJS.ProcessEnv): { bin: string; env: NodeJS.ProcessEnv }[] {
  const explicit = env.ZSWARM_TAILSCALE_BIN?.trim();
  if (explicit) return [{ bin: explicit, env }];
  const out: { bin: string; env: NodeJS.ProcessEnv }[] = [
    { bin: process.platform === "win32" ? "tailscale.exe" : "tailscale", env },
  ];
  if (process.platform === "darwin") {
    out.push({
      bin: MACOS_TAILSCALE,
      env: { ...env, TAILSCALE_BE_CLI: "1" },
    });
  }
  return out;
}

function runFile(
  bin: string,
  args: string[],
  options: { timeoutMs: number; env: NodeJS.ProcessEnv; signal?: AbortSignal; maxBuffer: number },
): Promise<{ code: number; stdout: string; stderr: string; err?: NodeJS.ErrnoException }> {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      {
        timeout: Math.max(1, options.timeoutMs),
        env: options.env,
        signal: options.signal,
        maxBuffer: options.maxBuffer,
        windowsHide: true,
        encoding: "utf8",
      },
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as { code?: unknown }).code === "number"
            ? (err as { code: number }).code
            : err
              ? 1
              : 0;
        resolve({
          code,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          err: err ? (err as NodeJS.ErrnoException) : undefined,
        });
      },
    );
  });
}

/**
 * Optional controller Tailscale evidence. `tailscale status --json` only.
 * Never installs, logs in, or changes network exposure.
 */
export async function inspectTailscalePeer(input: {
  env: NodeJS.ProcessEnv;
  destination: string | null;
  clock: Clock;
  signal?: AbortSignal;
  timeoutMs: number;
}): Promise<DoctorCheck> {
  const started = input.clock.now();
  const skip = (code: string, detail: string) =>
    timedCheck(
      input.clock,
      "tailscale",
      "controller",
      started,
      "skipped",
      code,
      detail,
      "Missing Tailscale CLI or an unmappable alias does not invalidate a working route.",
    );
  if (!input.destination) {
    return skip("tailscale_not_applicable", "Local route has no remote Tailscale peer to identify.");
  }
  const dest = peerKey(input.destination);
  if (!dest || dest === "localhost" || isLoopbackHost(dest)) {
    return skip(
      "tailscale_loopback",
      "Loopback is a tunnel endpoint, not crew-host Tailscale identity. Doctor does not guess a peer from 127.0.0.1.",
    );
  }
  if (input.timeoutMs <= 0) {
    return skip("timeout", "No remaining budget for the optional Tailscale probe.");
  }
  let lastMissing = "tailscale CLI not found";
  for (const candidate of tailscaleBins(input.env)) {
    throwIfAborted(input.signal);
    const result = await runFile(candidate.bin, ["status", TAILSCALE_JSON_FLAG], {
      timeoutMs: input.timeoutMs,
      env: candidate.env,
      signal: input.signal,
      maxBuffer: TAILSCALE_MAX_BYTES,
    });
    const code = result.err?.code;
    if (code === "ENOENT") {
      lastMissing = `tailscale CLI not found (${candidate.bin})`;
      continue;
    }
    if (code === "ABORT_ERR" || input.signal?.aborted) {
      return timedCheck(
        input.clock,
        "tailscale",
        "controller",
        started,
        "skipped",
        "cancelled",
        "Tailscale probe cancelled.",
        "",
      );
    }
    const timedOut =
      Boolean(result.err && "killed" in result.err && (result.err as { killed?: boolean }).killed) ||
      /timeout/i.test(result.err?.message ?? "");
    if (timedOut) {
      return skip("timeout", "tailscale status --json exceeded its bounded budget.");
    }
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout).trim() || `exit ${result.code}`;
      return skip(
        "tailscale_unavailable",
        `tailscale status --json failed (${detail.slice(0, 240)}). Local daemon denied/unavailable is advisory.`,
      );
    }
    let parsed: { BackendState?: string; Self?: TailscalePeer; Peer?: Record<string, TailscalePeer> };
    try {
      parsed = JSON.parse(result.stdout) as typeof parsed;
    } catch {
      return skip("tailscale_protocol", "tailscale status --json was not JSON.");
    }
    const matched = matchTailscalePeer(input.destination, parsed);
    if (!matched) {
      return skip(
        "tailscale_unmapped",
        `No Tailscale peer matched ${input.destination} by name or exact address. Aliases and manual tunnels stay unknown.`,
      );
    }
    const online = matched.peer.Online === true;
    const name = matched.peer.HostName || matched.peer.DNSName || "peer";
    return timedCheck(
      input.clock,
      "tailscale",
      "controller",
      started,
      "ok",
      online ? "tailscale_peer_online" : "tailscale_peer_offline",
      `Peer ${name} ${online ? "online" : "offline"} (${matched.how} evidence). This does not prove SSH or app access.`,
      online
        ? ""
        : "Peer is not online in tailscale status --json. That is not a substitute for SSH/serve/session checks.",
    );
  }
  return skip("tailscale_cli_missing", lastMissing);
}

function hostSessionSelection(
  env: NodeJS.ProcessEnv,
  explicit?: string | null,
): { session: string | null; origin: string } {
  const selected = selectedSession(env, explicit);
  return {
    session: selected?.session ?? null,
    origin: sessionOriginLabel(selected?.source),
  };
}

function classifyHostError(err: unknown): { code: string; detail: string; remedy: string } {
  if (err instanceof ZellijError) {
    const ssh = classifySshFailure(err.message);
    if (ssh) return { code: ssh.code, detail: err.message, remedy: ssh.remedy };
    if (err.code === "zellij_missing") {
      return {
        code: err.code,
        detail: err.message,
        remedy: "Install Zellij ≥ 0.42 on the crew host and put it on PATH, or set ZSWARM_BIN / ZSWARM_REMOTE_BIN.",
      };
    }
    if (err.code === "zellij_wrong_bin") {
      return {
        code: err.code,
        detail: err.message,
        remedy: "Point ZSWARM_BIN / ZSWARM_REMOTE_BIN at the zellij binary, not zswarm.",
      };
    }
    if (err.code === "zellij_incompatible") {
      return {
        code: err.code,
        detail: err.message,
        remedy: "Upgrade Zellij (≥ 0.42) so list-sessions --no-formatting is available.",
      };
    }
    if (err.code === "cancelled" || err.code === "timeout" || err.code === "observation_timeout") {
      return { code: err.code === "observation_timeout" ? "timeout" : err.code, detail: err.message, remedy: "" };
    }
    return {
      code: err.code,
      detail: err.message,
      remedy: "Inspect the crew host; doctor does not install or repair Zellij.",
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : "";
  if (name === "AbortError" || /operation cancelled/i.test(message)) {
    return { code: "cancelled", detail: message, remedy: "" };
  }
  const ssh = classifySshFailure(message);
  if (ssh) return { code: ssh.code, detail: message, remedy: ssh.remedy };
  return { code: "zellij_failed", detail: message, remedy: "Inspect the crew host; doctor does not install or repair Zellij." };
}

function negativeBus(env: NodeJS.ProcessEnv): boolean {
  const v = (env.ZSWARM_BUS ?? "").trim().toLowerCase();
  return v === "0" || v === "false" || v === "no" || v === "off";
}

function markerStale(plugin: string | undefined): boolean {
  return Boolean(plugin && !existsSync(plugin));
}

/**
 * Reusable host-local inspection for doctor and the later Windows install slice.
 * Inspect-only: no plugin pipes, pane mutations, state writes, or interactive SSH.
 */
export async function inspectHostCrew(input: InspectHostCrewInput): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const clock = input.clock;
  const budget = () => remainingMs(clock, input.deadlineAt);
  const started = () => clock.now();

  if (input.sshInteractive) {
    checks.push(
      skipped(
        "zellij",
        "host",
        "ssh_interactive_unsupported",
        "ZSWARM_SSH_MODE=interactive would create Windows scheduled tasks and temp IPC files. Doctor does not run that path.",
        SERVE_REMEDY,
      ),
    );
    checks.push(
      skipped("ipc", "host", "ssh_interactive_unsupported", "Interactive IPC discovery is not used by doctor.", SERVE_REMEDY),
    );
    checks.push(
      skipped("sessions", "host", "ssh_interactive_unsupported", "Host sessions were not listed without mutation.", SERVE_REMEDY),
    );
    const want = hostSessionSelection(input.env, input.explicitSession);
    if (want.session) {
      checks.push(
        timedCheck(
          clock,
          "session",
          "host",
          started(),
          "fail",
          "session_unverified",
          `Requested session ${want.session} was not verified; interactive SSH inspection is skipped.`,
          SERVE_REMEDY,
        ),
      );
    } else {
      checks.push(
        skipped("session", "host", "ssh_interactive_unsupported", "No host session could be verified without mutation.", SERVE_REMEDY),
      );
    }
    for (const id of ["bus_artifact", "bus_marker", "bus_instance"] as const) {
      checks.push(
        skipped(id, "host", "bus_unsupported_ssh", "Direct SSH cannot read the crew-host bus; controller files are not remote facts.", SERVE_REMEDY),
      );
    }
    return checks;
  }

  const env = input.env;
  const client =
    input.client ??
    createZellijClient({
      env,
      signal: input.signal,
      timeoutMs: Math.max(1, budget() || 1),
      cache: false,
    });

  const zellijStarted = started();
  let sessions: ZellijSession[] = [];
  try {
    throwIfAborted(input.signal);
    if (budget() <= 0) throw new ZellijError("timeout", "doctor timed out before host Zellij inspection");
    sessions = await client.listSessions(budget(), { fresh: true });
    checks.push(
      timedCheck(
        clock,
        "zellij",
        "host",
        zellijStarted,
        "ok",
        "zellij_ok",
        `Zellij binary ${client.zellijPath} responded to list-sessions.`,
        "",
      ),
    );
  } catch (err) {
    const classified = classifyHostError(err);
    const sshFail = classified.code.startsWith("ssh_");
    checks.push(
      timedCheck(
        clock,
        "zellij",
        "host",
        zellijStarted,
        "fail",
        sshFail ? "zellij_unreachable" : classified.code,
        classified.detail,
        classified.remedy,
      ),
    );
    if (sshFail) {
      // Surface SSH stage on the host zellij check; caller may also have an ssh check.
    }
    skipHostRest(checks, classified.code, classified.detail, classified.remedy);
    return checks;
  }

  const ipcStarted = started();
  const transport = client.transport;
  const ipc = transport.ipc;
  if (!ipc || ipc.status === "none") {
    checks.push(
      timedCheck(
        clock,
        "ipc",
        "host",
        ipcStarted,
        "ok",
        "ipc_default",
        transport.kind === "ssh"
          ? "SSH IPC uses the login environment (ZSWARM_TMP unset)."
          : "Local Zellij IPC (no ZSWARM_TMP override).",
        "",
      ),
    );
  } else if (ipc.status === "skipped") {
    checks.push(
      timedCheck(
        clock,
        "ipc",
        "host",
        ipcStarted,
        "ok",
        "ipc_configured",
        `Configured IPC temp ${ipc.tmp ?? ""}`.trim(),
        "",
      ),
    );
  } else if (ipc.status === "resolved") {
    checks.push(
      timedCheck(
        clock,
        "ipc",
        "host",
        ipcStarted,
        "ok",
        "ipc_resolved",
        `Resolved IPC tmp=${ipc.tmp ?? ""} socketDir=${ipc.socketDir ?? ""}`,
        "",
      ),
    );
  } else {
    checks.push(
      timedCheck(
        clock,
        "ipc",
        "host",
        ipcStarted,
        "fail",
        "ipc_unreachable",
        `ZSWARM_TMP=${ipc.requested ?? "auto"} status=${ipc.status}. Do not treat EXITED rows as a live crew.`,
        "Set ZSWARM_TMP to the desktop TEMP, or run zswarm serve beside Zellij. Doctor does not infer a Windows account without evidence.",
      ),
    );
    skipHostRest(
      checks,
      "ipc_unreachable",
      "Dependent session/bus checks skipped after inaccessible IPC.",
      SERVE_REMEDY,
    );
    return checks;
  }

  const live = liveSessionNames(sessions);
  const sessionsStarted = started();
  if (live.length === 0) {
    checks.push(
      timedCheck(
        clock,
        "sessions",
        "host",
        sessionsStarted,
        "warn",
        "sessions_empty",
        "No live Zellij sessions are visible on this host.",
        "Start a Zellij session on the crew host, or pass --session if a live session exists under another IPC.",
      ),
    );
  } else {
    checks.push(
      timedCheck(
        clock,
        "sessions",
        "host",
        sessionsStarted,
        "ok",
        "sessions_ok",
        `Visible live sessions: ${live.join(", ")}`,
        "",
      ),
    );
  }

  const sessionStarted = started();
  const want = hostSessionSelection(env, input.explicitSession);
  let resolvedSession = want.session;
  if (want.session) {
    if (live.includes(want.session)) {
      checks.push(
        timedCheck(
          clock,
          "session",
          "host",
          sessionStarted,
          "ok",
          "session_ok",
          `Session ${want.session} exists (${want.origin}).`,
          "",
        ),
      );
    } else {
      checks.push(
        timedCheck(
          clock,
          "session",
          "host",
          sessionStarted,
          "fail",
          "session_missing",
          `Session ${want.session} (${want.origin}) is not a live visible session.`,
          "Create or attach that Zellij session on the crew host. A reachable listener is not a usable crew.",
        ),
      );
      resolvedSession = null;
    }
  } else if (live.length === 1) {
    resolvedSession = live[0]!;
    checks.push(
      timedCheck(
        clock,
        "session",
        "host",
        sessionStarted,
        "ok",
        "session_ok",
        `Sole live session ${resolvedSession} (host_default).`,
        "",
      ),
    );
  } else {
    checks.push(
      timedCheck(
        clock,
        "session",
        "host",
        sessionStarted,
        live.length === 0 ? "warn" : "skipped",
        live.length === 0 ? "sessions_empty" : "session_unresolved",
        live.length === 0
          ? "No session was selected and none are visible."
          : `Multiple live sessions (${live.join(", ")}); pass session=.`,
        live.length === 0 ? "Start Zellij or pass --session." : "Pass --session (or ZSWARM_SESSION on the crew host).",
      ),
    );
  }

  if (input.bus === "unsupported_ssh") {
    for (const id of ["bus_artifact", "bus_marker", "bus_instance"] as const) {
      checks.push(
        skipped(
          id,
          "host",
          "bus_unsupported_ssh",
          "Direct SSH cannot observe the crew-host bus. Controller wasm/marker files are not remote facts.",
          SERVE_REMEDY,
        ),
      );
    }
    return checks;
  }

  const artifactStarted = started();
  const plugin = resolveBusPlugin(env);
  if (plugin) {
    checks.push(
      timedCheck(
        clock,
        "bus_artifact",
        "host",
        artifactStarted,
        "ok",
        "bus_artifact_ok",
        `Host wasm artifact present (${plugin}).`,
        "",
      ),
    );
  } else {
    checks.push(
      timedCheck(
        clock,
        "bus_artifact",
        "host",
        artifactStarted,
        "warn",
        "bus_artifact_missing",
        "No host-local bus wasm artifact. Missing bus is advisory.",
        "Build or install @zswarm/wasm, or set ZSWARM_BUS_PLUGIN on the crew host.",
      ),
    );
  }

  const state = input.state ?? createStateStore({ env });
  const markerStarted = started();
  const markerSession = resolvedSession ?? want.session;
  const marker = markerSession ? state.readBus(markerSession) : null;
  if (!markerSession) {
    checks.push(
      skipped("bus_marker", "host", "session_unresolved", "No session selected; install marker was not read."),
    );
  } else if (!marker) {
    checks.push(
      timedCheck(
        clock,
        "bus_marker",
        "host",
        markerStarted,
        "warn",
        "bus_marker_missing",
        `No bus install marker for session ${markerSession}. Advisory.`,
        'Run `zswarm bus --install` once on the crew host if the fast path is wanted.',
      ),
    );
  } else if (markerStale(marker.plugin)) {
    checks.push(
      timedCheck(
        clock,
        "bus_marker",
        "host",
        markerStarted,
        "warn",
        "bus_marker_stale",
        `Install marker names a missing plugin (${marker.plugin}).`,
        "Reinstall the bus plugin on the crew host after upgrading the wasm artifact.",
      ),
    );
  } else {
    checks.push(
      timedCheck(
        clock,
        "bus_marker",
        "host",
        markerStarted,
        "ok",
        "bus_marker_ok",
        `Install marker present for ${markerSession}.`,
        "",
      ),
    );
  }

  const instanceStarted = started();
  if (negativeBus(env)) {
    checks.push(
      timedCheck(
        clock,
        "bus_instance",
        "host",
        instanceStarted,
        "skipped",
        "bus_disabled",
        "ZSWARM_BUS=0; live instance was not observed. Bus remains advisory.",
        "",
      ),
    );
    return checks;
  }
  if (!resolvedSession) {
    checks.push(
      skipped(
        "bus_instance",
        "host",
        "bus_instance_unknown",
        "No session to list panes; plugin readiness is unknown. Doctor does not pipe to a plugin.",
      ),
    );
    return checks;
  }
  if (budget() <= 0) {
    checks.push(
      skipped("bus_instance", "host", "timeout", "No remaining budget to list panes for a live plugin instance."),
    );
    return checks;
  }
  try {
    throwIfAborted(input.signal);
    const panes = await client.listPanes(resolvedSession, budget(), { fresh: true });
    const livePlugin = panes.filter((pane) => isBusPluginPane(pane, plugin));
    if (livePlugin.length > 0) {
      checks.push(
        timedCheck(
          clock,
          "bus_instance",
          "host",
          instanceStarted,
          "ok",
          "bus_instance_present",
          `Observed ${livePlugin.length} bus plugin pane(s). Readiness is unknown without a verified existing-instance-only pipe; doctor does not launch or nudge the plugin.`,
          "",
        ),
      );
    } else {
      checks.push(
        timedCheck(
          clock,
          "bus_instance",
          "host",
          instanceStarted,
          "warn",
          "bus_instance_absent",
          "No live bus plugin pane is visible. Readiness is unready/unknown; silence is not pending permissions. Advisory.",
          "Install the bus on the crew host if the fast path is wanted. Doctor does not load the plugin.",
        ),
      );
    }
  } catch (err) {
    const classified = classifyHostError(err);
    checks.push(
      timedCheck(
        clock,
        "bus_instance",
        "host",
        instanceStarted,
        "skipped",
        classified.code === "cancelled" || classified.code === "timeout" ? classified.code : "bus_instance_unknown",
        `Could not list panes for a live instance (${classified.detail}). Readiness unknown.`,
        "",
      ),
    );
  }
  return checks;
}

function routeFromContext(
  context: RoutingContext,
  env: NodeJS.ProcessEnv,
  explicitSession: string | null,
): DoctorRoute {
  const serve = optionalString(env.ZSWARM_SERVE);
  let loopbackTunnel = false;
  if (context.transport === "serve" && serve && !isSshServeTarget(serve)) {
    try {
      loopbackTunnel = isLoopbackHost(parseListenAddress(serve).host);
    } catch {
      loopbackTunnel = false;
    }
  }
  if (context.transport === "serve" && serve && isSshServeTarget(serve)) {
    loopbackTunnel = true;
  }
  return {
    transport: context.transport,
    target: context.host,
    session: explicitSession,
    sessionOrigin: sessionOriginLabel(context.origin.session),
    selector: context.origin.transport,
    loopbackTunnel,
  };
}

function serverFromHello(hello: ServeHelloData): DoctorReport["server"] {
  return {
    hostname: hello.hostname,
    platform: hello.platform,
    version: hello.version,
    protocol: hello.protocol,
    serverId: hello.serverId,
    capabilities: [...hello.capabilities],
  };
}

function reportOutcome(report: DoctorReport, terminal?: { code: string; message: string }): OpsResult {
  if (terminal?.code === "cancelled") {
    return { ok: false, error: { code: "cancelled", message: terminal.message, details: report } };
  }
  if (terminal?.code === "timeout") {
    return { ok: false, error: { code: "timeout", message: terminal.message, details: report } };
  }
  const failed = report.checks.filter((c) => isDoctorRequiredCheck(c) && c.state === "fail");
  if (failed.length > 0) {
    const summary = failed.map((c) => `${c.id}:${c.code}`).join(", ");
    return {
      ok: false,
      error: {
        code: "doctor_failed",
        message: `doctor failed (${summary})`,
        details: report,
      },
    };
  }
  return { ok: true, data: report };
}

function hostRequest(explicitSession: string | null, timeoutMs: number): Record<string, unknown> {
  const request: Record<string, unknown> = {
    op: "doctor",
    timeoutMs,
    [DOCTOR_HOST_INSPECT_FIELD]: DOCTOR_HOST_INSPECT_VALUE,
  };
  if (explicitSession) request.session = explicitSession;
  return stripControllerRouting(request);
}

function hostReportFromResult(result: OpsResult): DoctorReport | null {
  if (result.ok && isDoctorReport(result.data)) return result.data;
  if (!result.ok && isDoctorReport(result.error.details)) return result.error.details as DoctorReport;
  return null;
}

function usageLooksUnsupported(result: OpsResult): boolean {
  if (result.ok) return false;
  const code = result.error.code;
  const message = result.error.message.toLowerCase();
  return (
    code === "usage" ||
    (/zswarm requires op=/i.test(result.error.message) && /doctor/.test(message) === false) ||
    /unknown op/.test(message) ||
    /requires op=/.test(message)
  );
}

async function collectServeHost(input: {
  target: string;
  token?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  explicitSession: string | null;
  hello?: ServeHelloData;
}): Promise<{ checks: DoctorCheck[]; terminal?: { code: string; message: string } }> {
  const caps = input.hello?.capabilities ?? [];
  if (input.hello && !caps.includes(SERVE_CAPABILITY_DOCTOR)) {
    const checks: DoctorCheck[] = [];
    skipHostRest(
      checks,
      "doctor_unsupported",
      "Serve hello succeeded but this peer lacks the doctor capability.",
      "Upgrade zswarm serve on the crew host.",
    );
    return { checks };
  }
  const result = await callServe(
    input.target,
    hostRequest(input.explicitSession, input.timeoutMs),
    {
      timeoutMs: Math.max(1, input.timeoutMs),
      token: input.token,
      signal: input.signal,
      connectTimeoutMs: Math.max(1, input.timeoutMs),
    },
  );
  if (result.ok || isDoctorReport(result.error?.details)) {
    const report = hostReportFromResult(result);
    const hostChecks = report?.checks.filter((c) => c.scope === "host") ?? [];
    if (hostChecks.length > 0) {
      const terminal =
        !result.ok && (result.error.code === "timeout" || result.error.code === "cancelled")
          ? { code: result.error.code, message: result.error.message }
          : undefined;
      return { checks: hostChecks, terminal };
    }
  }
  if (!result.ok && (result.error.code === "timeout" || result.error.code === "cancelled")) {
    const checks: DoctorCheck[] = [];
    skipHostRest(checks, result.error.code, result.error.message);
    return { checks, terminal: { code: result.error.code, message: result.error.message } };
  }
  if (!result.ok && (usageLooksUnsupported(result) || result.error.code === "serve_hello_unsupported")) {
    const checks: DoctorCheck[] = [];
    skipHostRest(
      checks,
      "doctor_unsupported",
      result.error.message,
      "Upgrade zswarm serve on the crew host so doctor can inspect Zellij without mutating the session.",
    );
    return { checks };
  }
  const checks: DoctorCheck[] = [];
  skipHostRest(
    checks,
    result.ok ? "doctor_unsupported" : result.error.code,
    result.ok ? "Host doctor returned no host checks." : result.error.message,
    "Upgrade zswarm serve or inspect the host directly. Doctor does not fall back to another route.",
  );
  return { checks };
}

function makeClock(deps: DispatchDeps): Clock {
  const signal = deps.signal;
  return {
    now: deps.now ?? (() => Date.now()),
    sleep:
      deps.sleep ??
      ((ms: number) =>
        new Promise<void>((resolve, reject) => {
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
            signal?.removeEventListener("abort", onAbort);
            reject(new ZellijError("cancelled", "operation cancelled"));
          };
          signal?.addEventListener("abort", onAbort, { once: true });
        })),
  };
}

/**
 * Inspect-only doctor. Callers must invoke this before ordinary serve forwarding
 * and before mandatory session resolution.
 */
export async function runDoctor(
  args: Record<string, unknown>,
  deps: DispatchDeps,
  context: RoutingContext,
  env: NodeJS.ProcessEnv,
  injected?: ZellijClient,
): Promise<OpsResult> {
  const clock = makeClock(deps);
  const signal = deps.signal;
  const timeoutMs = numberArg(args, "timeoutMs", DEFAULT_DOCTOR_TIMEOUT_MS, {
    min: 1,
    max: 900_000,
  });
  const deadlineAt = clock.now() + timeoutMs;
  const remaining = () => remainingMs(clock, deadlineAt);
  const explicitSession = optionalString(args.session);
  const hostOnly = args[DOCTOR_HOST_INSPECT_FIELD] === DOCTOR_HOST_INSPECT_VALUE;
  const checks: DoctorCheck[] = [];
  let terminal: { code: string; message: string } | undefined;
  let server: DoctorReport["server"];

  const finish = (route: DoctorRoute): OpsResult => {
    if (!terminal && signal?.aborted) {
      terminal = { code: "cancelled", message: "operation cancelled" };
    }
    const report: DoctorReport = { route, checks, ...(server ? { server } : {}) };
    return reportOutcome(report, terminal);
  };

  try {
    throwIfAborted(signal);
    if (hostOnly) {
      const hostEnv = { ...env };
      delete hostEnv.ZSWARM_SERVE;
      delete hostEnv.ZSWARM_SSH;
      const route: DoctorRoute = {
        transport: "local",
        target: hostname() || "local",
        session: explicitSession ?? selectedSession(hostEnv, explicitSession)?.session ?? null,
        sessionOrigin: sessionOriginLabel(selectedSession(hostEnv, explicitSession)?.source ?? context.origin.session),
        selector: "host",
        loopbackTunnel: false,
      };
      const hostChecks = await inspectHostCrew({
        env: hostEnv,
        clock,
        signal,
        deadlineAt,
        explicitSession,
        client: injected,
        state: deps.state,
        bus: "host",
      });
      checks.push(...hostChecks);
      if (remaining() <= 0 && hostChecks.some((c) => c.code === "timeout")) {
        terminal = { code: "timeout", message: "doctor timed out during host inspection" };
      }
      return finish(route);
    }

    const routeStarted = clock.now();
    const route = routeFromContext(context, env, explicitSession);
    checks.push(
      timedCheck(
        clock,
        "route",
        "controller",
        routeStarted,
        "ok",
        "route_selected",
        `${route.transport} ${route.target}` +
          (route.loopbackTunnel ? " (loopback/tunnel, not necessarily the crew host)" : "") +
          `; session ${route.session ?? "(none)"} (${route.sessionOrigin}); selector ${route.selector}`,
        "",
      ),
    );

    const tailscaleBudget = Math.min(TAILSCALE_MAX_MS, Math.max(1, Math.floor(timeoutMs * 0.15)));
    const dest = destinationHost(context, env);
    try {
      throwIfAborted(signal);
      checks.push(
        await inspectTailscalePeer({
          env,
          destination: dest,
          clock,
          signal,
          timeoutMs: Math.min(tailscaleBudget, remaining()),
        }),
      );
    } catch (err) {
      if (err instanceof ZellijError && err.code === "cancelled") {
        terminal = { code: "cancelled", message: err.message };
        skipHostRest(checks, "cancelled", err.message);
        checks.push(skipped("serve", "controller", "cancelled", "Cancelled before transport checks."));
        checks.push(skipped("ssh", "controller", "cancelled", "Cancelled before transport checks."));
        return finish(route);
      }
      throw err;
    }

    if (signal?.aborted) {
      terminal = { code: "cancelled", message: "operation cancelled" };
      skipHostRest(checks, "cancelled", "operation cancelled");
      return finish(route);
    }
    if (remaining() <= 0) {
      terminal = { code: "timeout", message: "doctor timed out before transport checks" };
      if (!checks.some((c) => c.id === "serve")) {
        checks.push(skipped("serve", "controller", "timeout", "doctor timed out before transport checks"));
      }
      if (!checks.some((c) => c.id === "ssh")) {
        checks.push(skipped("ssh", "controller", "timeout", "doctor timed out before transport checks"));
      }
      skipHostRest(checks, "timeout", "doctor timed out before transport checks");
      return finish(route);
    }

    if (context.transport === "serve") {
      const serveTarget = optionalString(env.ZSWARM_SERVE);
      if (!serveTarget) {
        checks.push(
          timedCheck(
            clock,
            "serve",
            "controller",
            clock.now(),
            "fail",
            "serve_unreachable",
            "Serve route selected but ZSWARM_SERVE is empty.",
            "Pass --serve or ZSWARM_SERVE.",
          ),
        );
        skipHostRest(checks, "serve_unreachable", "No serve endpoint.");
        checks.push(skipped("ssh", "controller", "not_applicable", "Serve route does not use direct SSH."));
        return finish(route);
      }
      checks.push(skipped("ssh", "controller", "not_applicable", "Serve route does not use direct SSH."));
      const token = env.ZSWARM_SERVE_TOKEN;
      const serveStarted = clock.now();
      if (isSshServeTarget(serveTarget)) {
        const owned = deps.serveTunnels;
        const manager = owned ?? createServeTunnelManager({ persistIdle: false, now: clock.now });
        try {
          const acquired = await manager.acquire(serveTarget, {
            env,
            token,
            timeoutMs: remaining(),
            signal,
          });
          if (!("handle" in acquired)) {
            const failed = acquired;
            if (!failed.ok) {
              checks.push(serveStageCheck(clock, serveStarted, failed, true));
              if (failed.error.code === "cancelled" || failed.error.code === "timeout") {
                terminal = { code: failed.error.code, message: failed.error.message };
              }
              skipHostRest(checks, failed.error.code, failed.error.message);
            } else {
              skipHostRest(checks, "serve_unreachable", "ssh:// acquire did not return a tunnel handle");
            }
            return finish(route);
          }
          try {
            server = serverFromHello(acquired.hello);
            checks.push(
              timedCheck(
                clock,
                "serve",
                "controller",
                serveStarted,
                "ok",
                "serve_ok",
                `Authenticated hello from ${acquired.hello.hostname} (${acquired.hello.platform} ${acquired.hello.version}) via ${acquired.localTarget}.`,
                "",
              ),
            );
            if (remaining() <= 0) {
              terminal = { code: "timeout", message: "doctor timed out after serve hello" };
              skipHostRest(checks, "timeout", "doctor timed out after serve hello");
              return finish(route);
            }
            const host = await collectServeHost({
              target: acquired.localTarget,
              token,
              timeoutMs: remaining(),
              signal,
              explicitSession,
              hello: acquired.hello,
            });
            checks.push(...host.checks);
            terminal = host.terminal;
            return finish(route);
          } finally {
            await acquired.handle.release();
          }
        } finally {
          if (!owned) await manager.closeAll();
        }
      }

      const probed = await probeServe(serveTarget, {
        token,
        timeoutMs: remaining(),
        signal,
      });
      checks.push(serveStageCheck(clock, serveStarted, probed, false));
      if (!probed.ok) {
        if (probed.error.code === "cancelled" || probed.error.code === "timeout") {
          terminal = { code: probed.error.code, message: probed.error.message };
        }
        skipHostRest(checks, probed.error.code, probed.error.message);
        return finish(route);
      }
      server = serverFromHello(probed.data as ServeHelloData);
      if (remaining() <= 0) {
        terminal = { code: "timeout", message: "doctor timed out after serve hello" };
        skipHostRest(checks, "timeout", "doctor timed out after serve hello");
        return finish(route);
      }
      const host = await collectServeHost({
        target: serveTarget,
        token,
        timeoutMs: remaining(),
        signal,
        explicitSession,
        hello: probed.data as ServeHelloData,
      });
      checks.push(...host.checks);
      terminal = host.terminal;
      return finish(route);
    }

    if (context.transport === "ssh") {
      checks.push(skipped("serve", "controller", "not_applicable", "Direct SSH route does not use zswarm serve."));
      const sshStarted = clock.now();
      let interactive = false;
      try {
        interactive = validateSshMode(env.ZSWARM_SSH_MODE ?? "") === "interactive";
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        checks.push(
          timedCheck(clock, "ssh", "controller", sshStarted, "fail", "bad_ssh_mode", message, "Set ZSWARM_SSH_MODE to ssh or interactive, or unset it."),
        );
        skipHostRest(checks, "bad_ssh_mode", message);
        return finish(route);
      }
      if (interactive) {
        checks.push(
          timedCheck(
            clock,
            "ssh",
            "controller",
            sshStarted,
            "warn",
            "ssh_interactive_unsupported",
            "Interactive SSH is selected; doctor does not create Windows tasks or temp IPC files.",
            SERVE_REMEDY,
          ),
        );
        const hostChecks = await inspectHostCrew({
          env,
          clock,
          signal,
          deadlineAt,
          explicitSession,
          bus: "unsupported_ssh",
          sshInteractive: true,
        });
        checks.push(...hostChecks);
        return finish(route);
      }
      try {
        throwIfAborted(signal);
        if (remaining() <= 0) throw new ZellijError("timeout", "doctor timed out before SSH host inspection");
        const hostChecks = await inspectHostCrew({
          env,
          clock,
          signal,
          deadlineAt,
          explicitSession,
          client: injected,
          state: deps.state,
          bus: "unsupported_ssh",
        });
        const zellij = hostChecks.find((c) => c.id === "zellij");
        const sshClass = zellij ? classifySshFailure(zellij.detail) : null;
        if (sshClass) {
          checks.push(
            timedCheck(clock, "ssh", "controller", sshStarted, "fail", sshClass.code, zellij!.detail, sshClass.remedy),
          );
          skipHostRest(checks, sshClass.code, zellij!.detail, sshClass.remedy);
          return finish(route);
        }
        checks.push(
          timedCheck(
            clock,
            "ssh",
            "controller",
            sshStarted,
            "ok",
            "ssh_ok",
            "SSH destination accepted a non-interactive Zellij probe (OpenSSH; not Tailscale SSH).",
            "",
          ),
        );
        checks.push(...hostChecks);
        if (remaining() <= 0 && hostChecks.some((c) => c.code === "timeout")) {
          terminal = { code: "timeout", message: "doctor timed out during SSH host inspection" };
        }
        return finish(route);
      } catch (err) {
        const classified = classifyHostError(err);
        if (classified.code === "cancelled" || classified.code === "timeout") {
          terminal = { code: classified.code, message: classified.detail };
        }
        const ssh = classified.code.startsWith("ssh_") ? classified : classifySshFailure(classified.detail);
        checks.push(
          timedCheck(
            clock,
            "ssh",
            "controller",
            sshStarted,
            classified.code === "cancelled" ? "skipped" : "fail",
            ssh?.code ?? classified.code,
            classified.detail,
            ssh && "remedy" in ssh ? ssh.remedy : classified.remedy,
          ),
        );
        skipHostRest(checks, classified.code, classified.detail, classified.remedy);
        return finish(route);
      }
    }

    checks.push(skipped("serve", "controller", "not_applicable", "Local route does not use zswarm serve."));
    checks.push(skipped("ssh", "controller", "not_applicable", "Local route does not use SSH."));
    const hostChecks = await inspectHostCrew({
      env,
      clock,
      signal,
      deadlineAt,
      explicitSession,
      client: injected,
      state: deps.state,
      bus: "host",
    });
    checks.push(...hostChecks);
    if (remaining() <= 0 && hostChecks.some((c) => c.code === "timeout")) {
      terminal = { code: "timeout", message: "doctor timed out during host inspection" };
    }
    return finish(route);
  } catch (err) {
    if (err instanceof ZellijError && (err.code === "cancelled" || err.code === "timeout" || err.code === "observation_timeout")) {
      terminal = {
        code: err.code === "observation_timeout" ? "timeout" : err.code,
        message: err.message,
      };
      skipHostRest(checks, terminal.code, err.message);
      const route = routeFromContext(context, env, explicitSession);
      if (!checks.some((c) => c.id === "route")) {
        checks.unshift(
          timedCheck(clock, "route", "controller", clock.now(), "ok", "route_selected", `${context.transport} ${context.host}`, ""),
        );
      }
      return finish(route);
    }
    throw err;
  }
}
