import { execFile } from "node:child_process";
import { isIP } from "node:net";
import { networkInterfaces as osNetworkInterfaces, type NetworkInterfaceInfo } from "node:os";
import { ZellijError } from "../errors.js";
import { NOT_FOUND_EXIT } from "../exec.js";
import { throwIfAborted } from "./util.js";

function isLoopbackListenHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return (
    h === "127.0.0.1" ||
    h === "localhost" ||
    h === "::1" ||
    h === "0:0:0:0:0:0:0:1"
  );
}

/** Bounded read of `tailscale status --json` for serve bind authorization. */
export const SERVE_BIND_STATUS_MAX_BYTES = 256 * 1024;
/** Default verification/startup budget for foreground `serve --listen` (not the server lifetime). */
export const SERVE_BIND_VERIFY_TIMEOUT_MS = 10_000;
/** Env override for the Tailscale CLI binary (persisted on Windows install when set). */
export const SERVE_TAILSCALE_BIN_ENV = "ZSWARM_TAILSCALE_BIN";

export type TailscaleStatusRunner = (input: {
  timeoutMs: number;
  signal?: AbortSignal;
  env: NodeJS.ProcessEnv;
}) => Promise<{ code: number; stdout: string; stderr: string }>;

export type NetworkInterfacesFn = () => NodeJS.Dict<NetworkInterfaceInfo[]>;

export type ServeBindDeps = {
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** Overall verification/startup budget (install shares its deadline remaining). */
  timeoutMs?: number;
  now?: () => number;
  tailscaleStatus?: TailscaleStatusRunner;
  networkInterfaces?: NetworkInterfacesFn;
};

export type ServeBindAuthorization = {
  /** Exact host string passed to `server.listen` (literal, never a hostname). */
  bindHost: string;
  /** Canonical form used for membership checks. */
  canonical: string;
  family: 4 | 6;
  mode: "loopback" | "tailscale";
};

export const SERVE_BIND_REMEDY = {
  literal:
    "Pass an explicit literal Tailscale IP from `tailscale ip -4` or `tailscale ip -6` (for example --listen 100.x.y.z:9419 or --listen '[fd7a:…]:9419'). Wildcards, hostnames, and non-Tailscale LAN/public addresses are refused.",
  loopbackDefault:
    "Default loopback (`127.0.0.1` / `::1`) needs no Tailscale CLI. Off-machine access stays an SSH tunnel to that loopback, or bind an owned Tailscale IP explicitly.",
  token:
    "Set ZSWARM_SERVE_TOKEN before serve. Tailnet membership does not replace the application token.",
  cliMissing:
    "Install the Tailscale CLI on this host (or set ZSWARM_TAILSCALE_BIN to its path), then retry. Loopback serve does not need Tailscale.",
  daemon:
    "Start Tailscale on this host (`tailscale up`) so `tailscale status --json` reports BackendState Running, then retry with the address from `tailscale ip`.",
  statusShape:
    "Tailscale status JSON was missing, truncated, oversized, or not the expected shape. Retry when `tailscale status --json --peers=false` succeeds locally.",
  notSelf:
    "That address is not in this node's Tailscale self addresses. Use `tailscale ip -4` / `-6` on this host; peer, subnet, and MagicDNS names are not bind identity.",
  conflict:
    "Tailscale status Self.TailscaleIPs and top-level TailscaleIPs disagree. Fix the local Tailscale profile, then retry.",
  osMissing:
    "Tailscale reported the address, but it is not assigned on a local OS interface (userspace/proxy-only Tailscale cannot use this mode). Use loopback + managed SSH, or enable a kernel/TUN Tailscale interface that owns the address.",
  cancelled: "Serve bind verification was cancelled before listen.",
  timeout:
    "Serve bind verification timed out before listen. Retry with a larger --timeout-ms on install, or check that the Tailscale CLI responds quickly.",
  bind:
    "Bind failed on the verified address with no fallback to 0.0.0.0, ::, loopback, or SSH. Free the port or restore the Tailscale address, then restart serve so verification runs again.",
} as const;

function fail(
  message: string,
  details: Record<string, unknown>,
  remedy: string,
): never {
  throw new ZellijError("serve_auth", message, { ...details, remedy });
}

/** Expand IPv6 to a fixed lowercase 8-hextet form for exact membership checks. */
export function expandIPv6(address: string): string | null {
  const raw = address.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!raw || raw.includes(".") || isIP(raw) !== 6) return null;
  if (raw.includes(":::")) return null;
  const sides = raw.split("::");
  if (sides.length > 2) return null;
  const head = sides[0] ? sides[0].split(":") : [];
  const tail = sides.length === 2 && sides[1] ? sides[1].split(":") : [];
  if (sides.length === 1 && head.length !== 8) return null;
  const missing = 8 - (head.length + tail.length);
  if (sides.length === 2 && missing < 0) return null;
  if (sides.length === 1 && missing !== 0) return null;
  const mid = sides.length === 2 ? Array.from({ length: missing }, () => "0") : [];
  const parts = [...head, ...mid, ...tail];
  if (parts.length !== 8) return null;
  const hextets: string[] = [];
  for (const part of parts) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    hextets.push(part.padStart(4, "0"));
  }
  return hextets.join(":");
}

const UNSPECIFIED_V6 = "0000:0000:0000:0000:0000:0000:0000:0000";

function isUnsafeCanonicalIPv6(canonical: string): boolean {
  if (canonical === UNSPECIFIED_V6) return true;
  // IPv4-mapped (::ffff:x) after expansion, any spelling of the input.
  const parts = canonical.split(":");
  return (
    parts.length === 8 &&
    parts[0] === "0000" &&
    parts[1] === "0000" &&
    parts[2] === "0000" &&
    parts[3] === "0000" &&
    parts[4] === "0000" &&
    parts[5] === "ffff"
  );
}

/**
 * Canonicalize a strict literal IP for comparison. Rejects hostnames, wildcards,
 * unspecified addresses, and IPv4-mapped IPv6 after full expansion (no silent
 * bypass onto the embedded v4 address).
 */
export function canonicalizeListenIp(raw: string): { family: 4 | 6; canonical: string } | null {
  const host = raw.trim().replace(/^\[|\]$/g, "");
  if (!host) return null;
  if (host === "0.0.0.0" || host === "::" || host === "*" || host === "0") return null;
  const kind = isIP(host);
  if (kind === 4) {
    const parts = host.split(".");
    if (parts.length !== 4) return null;
    const octets: number[] = [];
    for (const part of parts) {
      if (!/^\d{1,3}$/.test(part)) return null;
      if (part.length > 1 && part.startsWith("0")) return null;
      const n = Number(part);
      if (!Number.isInteger(n) || n < 0 || n > 255) return null;
      octets.push(n);
    }
    const canonical = octets.join(".");
    if (canonical === "0.0.0.0") return null;
    return { family: 4, canonical };
  }
  if (kind === 6) {
    const canonical = expandIPv6(host);
    if (!canonical || isUnsafeCanonicalIPv6(canonical)) return null;
    return { family: 6, canonical };
  }
  return null;
}

export function sameCanonicalIp(a: string, b: string): boolean {
  const left = canonicalizeListenIp(a);
  const right = canonicalizeListenIp(b);
  return Boolean(left && right && left.family === right.family && left.canonical === right.canonical);
}

function setKey(entry: { family: 4 | 6; canonical: string }): string {
  return `${entry.family}/${entry.canonical}`;
}

function sameAddressSet(
  a: { family: 4 | 6; canonical: string }[],
  b: { family: 4 | 6; canonical: string }[],
): boolean {
  if (a.length !== b.length) return false;
  const keys = new Set(a.map(setKey));
  return b.every((entry) => keys.has(setKey(entry)));
}

/**
 * Parse a present TailscaleIP list field. Fail closed on non-arrays and any
 * non-canonicalizable member; do not filter invalid entries away.
 */
function parsePresentIpList(
  value: unknown,
  field: string,
): { family: 4 | 6; canonical: string }[] {
  if (!Array.isArray(value)) {
    fail(
      `zswarm serve Tailscale ${field} is not a valid address list`,
      { phase: "verify", cause: "invalid_ip_list", field },
      SERVE_BIND_REMEDY.statusShape,
    );
  }
  const out: { family: 4 | 6; canonical: string }[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || !item.trim()) {
      fail(
        `zswarm serve Tailscale ${field} contains a malformed address entry`,
        { phase: "verify", cause: "malformed_ip_entry", field },
        SERVE_BIND_REMEDY.statusShape,
      );
    }
    const normalized = canonicalizeListenIp(item);
    if (!normalized) {
      fail(
        `zswarm serve Tailscale ${field} contains an unusable address`,
        { phase: "verify", cause: "invalid_ip_entry", field },
        SERVE_BIND_REMEDY.statusShape,
      );
    }
    const key = setKey(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

export function resolveTailscaleBin(env: NodeJS.ProcessEnv): string {
  const override = env[SERVE_TAILSCALE_BIN_ENV]?.trim();
  return override || "tailscale";
}

export function defaultServeTailscaleStatus(input: {
  timeoutMs: number;
  signal?: AbortSignal;
  env: NodeJS.ProcessEnv;
}): Promise<{ code: number; stdout: string; stderr: string }> {
  const bin = resolveTailscaleBin(input.env);
  return new Promise((resolve) => {
    execFile(
      bin,
      ["status", "--json", "--peers=false"],
      {
        timeout: Math.max(1, input.timeoutMs),
        maxBuffer: SERVE_BIND_STATUS_MAX_BYTES,
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
          stdout: String(stdout ?? "").slice(0, SERVE_BIND_STATUS_MAX_BYTES),
          stderr: String(stderr ?? "").slice(0, 4_096),
        });
      },
    );
  });
}

function osOwnsCanonical(
  target: { family: 4 | 6; canonical: string },
  ifaces: NodeJS.Dict<NetworkInterfaceInfo[]>,
): boolean {
  for (const list of Object.values(ifaces)) {
    if (!list) continue;
    for (const info of list) {
      const normalized = canonicalizeListenIp(info.address);
      if (
        normalized &&
        normalized.family === target.family &&
        normalized.canonical === target.canonical
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Authorize a serve listen host. Loopback needs no Tailscale evidence. Any other
 * host requires a strict literal IP present in fresh local Tailscale self
 * addresses and assigned on a local OS interface.
 *
 * Uses one startup budget (`timeoutMs` from `now`) across CLI and OS stages.
 * Does not install a lifetime timer on a healthy server.
 */
export async function authorizeServeListen(
  host: string,
  deps: ServeBindDeps = {},
): Promise<ServeBindAuthorization> {
  const env = deps.env ?? process.env;
  const signal = deps.signal;
  const now = deps.now ?? Date.now;
  throwIfAborted(signal);

  if (isLoopbackListenHost(host)) {
    const bindHost = host.trim().replace(/^\[|\]$/g, "");
    return {
      bindHost,
      canonical: bindHost.toLowerCase(),
      family: bindHost.includes(":") ? 6 : 4,
      mode: "loopback",
    };
  }

  const literal = canonicalizeListenIp(host);
  if (!literal) {
    fail(
      `zswarm serve refuses non-literal or unsafe listen host (${host}); bind only loopback or a verified local Tailscale IP`,
      { phase: "verify", cause: "listen_host", host },
      SERVE_BIND_REMEDY.literal,
    );
  }

  const timeoutMs = Math.max(1, Math.floor(deps.timeoutMs ?? SERVE_BIND_VERIFY_TIMEOUT_MS));
  const deadline = now() + timeoutMs;
  const remaining = (): number => deadline - now();
  const assertRunnable = (stage: string): number => {
    throwIfAborted(signal);
    const left = remaining();
    if (left <= 0) {
      fail(
        `zswarm serve bind verification timed out during ${stage} before listen`,
        { phase: "verify", cause: "timeout", stage },
        SERVE_BIND_REMEDY.timeout,
      );
    }
    return left;
  };

  const runner = deps.tailscaleStatus ?? defaultServeTailscaleStatus;
  const ifacesFn = deps.networkInterfaces ?? osNetworkInterfaces;

  const statusBudget = assertRunnable("status");
  let statusResult: { code: number; stdout: string; stderr: string };
  try {
    statusResult = await runner({ timeoutMs: statusBudget, signal, env });
  } catch (err) {
    if (err instanceof ZellijError) throw err;
    fail(
      `Tailscale status failed during serve bind verification (${err instanceof Error ? err.message : "error"})`,
      { phase: "verify", cause: "tailscale_status" },
      SERVE_BIND_REMEDY.daemon,
    );
  }
  assertRunnable("status");

  if (statusResult.code === NOT_FOUND_EXIT) {
    fail(
      "zswarm serve cannot verify a Tailscale listen address because the Tailscale CLI is missing",
      { phase: "verify", cause: "cli_missing" },
      SERVE_BIND_REMEDY.cliMissing,
    );
  }
  if (statusResult.code === -1) {
    const cancelled = /cancel/i.test(statusResult.stderr) || signal?.aborted;
    fail(
      cancelled
        ? "zswarm serve bind verification was cancelled before listen"
        : "zswarm serve bind verification timed out before listen",
      { phase: "verify", cause: cancelled ? "cancelled" : "timeout" },
      cancelled ? SERVE_BIND_REMEDY.cancelled : SERVE_BIND_REMEDY.timeout,
    );
  }
  if (statusResult.code !== 0) {
    const combined = `${statusResult.stdout}\n${statusResult.stderr}`.toLowerCase();
    const denied =
      /permission denied|access denied|failed to connect|tailscaled|daemon|stopped|needs.?login|logged out/.test(
        combined,
      );
    fail(
      denied
        ? "zswarm serve cannot reach the local Tailscale daemon to verify the listen address"
        : "zswarm serve Tailscale status failed while verifying the listen address",
      { phase: "verify", cause: denied ? "daemon_unavailable" : "status_failed", exit: statusResult.code },
      SERVE_BIND_REMEDY.daemon,
    );
  }

  const rawStdout = statusResult.stdout;
  if (!rawStdout.trim()) {
    fail(
      "zswarm serve received empty Tailscale status JSON while verifying the listen address",
      { phase: "verify", cause: "empty_status" },
      SERVE_BIND_REMEDY.statusShape,
    );
  }
  if (Buffer.byteLength(rawStdout, "utf8") >= SERVE_BIND_STATUS_MAX_BYTES) {
    fail(
      "zswarm serve Tailscale status JSON exceeded the verification size cap",
      { phase: "verify", cause: "oversize_status" },
      SERVE_BIND_REMEDY.statusShape,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawStdout);
  } catch {
    fail(
      "zswarm serve Tailscale status JSON was malformed while verifying the listen address",
      { phase: "verify", cause: "malformed_json" },
      SERVE_BIND_REMEDY.statusShape,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail(
      "zswarm serve Tailscale status JSON was not an object",
      { phase: "verify", cause: "invalid_status" },
      SERVE_BIND_REMEDY.statusShape,
    );
  }

  const status = parsed as Record<string, unknown>;
  const backend =
    typeof status.BackendState === "string" ? status.BackendState.trim() : "";
  if (backend !== "Running") {
    fail(
      `zswarm serve requires Tailscale BackendState Running to bind a Tailscale address (saw ${backend || "missing"})`,
      { phase: "verify", cause: "backend_state", backendState: backend || null },
      SERVE_BIND_REMEDY.daemon,
    );
  }

  if (!status.Self || typeof status.Self !== "object" || Array.isArray(status.Self)) {
    fail(
      "zswarm serve Tailscale status is missing Self; cannot authorize a Tailscale listen address",
      { phase: "verify", cause: "missing_self" },
      SERVE_BIND_REMEDY.statusShape,
    );
  }

  const selfRow = status.Self as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(selfRow, "TailscaleIPs")) {
    fail(
      "zswarm serve Tailscale Self.TailscaleIPs is missing; cannot authorize a Tailscale listen address",
      { phase: "verify", cause: "missing_self_ips" },
      SERVE_BIND_REMEDY.statusShape,
    );
  }
  const selfIps = parsePresentIpList(selfRow.TailscaleIPs, "Self.TailscaleIPs");
  if (selfIps.length === 0) {
    fail(
      "zswarm serve Tailscale Self.TailscaleIPs is empty; cannot authorize a Tailscale listen address",
      { phase: "verify", cause: "empty_self_ips" },
      SERVE_BIND_REMEDY.notSelf,
    );
  }

  // Absent root TailscaleIPs is allowed (Self is authoritative). A present
  // field — including [] or a non-array — must be structurally valid and match Self.
  if (Object.prototype.hasOwnProperty.call(status, "TailscaleIPs")) {
    const rootIps = parsePresentIpList(status.TailscaleIPs, "TailscaleIPs");
    if (!sameAddressSet(selfIps, rootIps)) {
      fail(
        "zswarm serve Tailscale Self.TailscaleIPs and TailscaleIPs conflict; refusing bind",
        { phase: "verify", cause: "self_root_conflict" },
        SERVE_BIND_REMEDY.conflict,
      );
    }
  }

  // Peer entries are never identity evidence, even if a buggy CLI still emits them.
  const matched = selfIps.find(
    (entry) => entry.family === literal.family && entry.canonical === literal.canonical,
  );
  if (!matched) {
    fail(
      `zswarm serve listen address ${host} is not a verified local Tailscale self address`,
      { phase: "verify", cause: "not_self_address", host: literal.canonical },
      SERVE_BIND_REMEDY.notSelf,
    );
  }

  assertRunnable("interfaces");
  let ifaces: NodeJS.Dict<NetworkInterfaceInfo[]>;
  try {
    ifaces = ifacesFn();
  } catch (err) {
    fail(
      `zswarm serve could not read OS interface addresses (${err instanceof Error ? err.message : "error"})`,
      { phase: "verify", cause: "os_interfaces" },
      SERVE_BIND_REMEDY.osMissing,
    );
  }
  assertRunnable("interfaces");
  if (!osOwnsCanonical(matched, ifaces ?? {})) {
    fail(
      `zswarm serve listen address ${literal.canonical} is not assigned on a local OS interface`,
      { phase: "verify", cause: "os_unassigned", host: literal.canonical },
      SERVE_BIND_REMEDY.osMissing,
    );
  }

  assertRunnable("authorize");
  return {
    bindHost: host.trim().replace(/^\[|\]$/g, ""),
    canonical: matched.canonical,
    family: matched.family,
    mode: "tailscale",
  };
}
