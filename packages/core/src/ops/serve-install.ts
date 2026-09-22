import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { ZellijError } from "../errors.js";
import { encodePowerShellCommand } from "../zellij/ipc.js";
import {
  coverHostReport,
  hostDoctorRequest,
  mergeHostReply,
  type DoctorCheck,
} from "./doctor.js";
import {
  callServe,
  isLoopbackHost,
  parseListenAddress,
  probeServe,
  redactServeSecret,
  SERVE_HELLO_TIMEOUT_MS,
  SERVE_LAUNCH_ID_ENV,
  SERVE_PROTOCOL,
  SERVE_TASK_NAME,
  serveLogonCommand,
  type CallServeOptions,
  type ProbeServeOptions,
  type ServeHelloData,
} from "./serve.js";
import type { OpsResult, ServeInstallDeps } from "./types.js";
import { throwIfAborted } from "./util.js";

/** Overall install/readiness deadline when `timeoutMs` is omitted. */
export const DEFAULT_SERVE_INSTALL_TIMEOUT_MS = 30_000;
export const SERVE_NOT_READY_CODE = "serve_not_ready";
export const SERVE_TASK_OWNED_CODE = "serve_task_owned";

const HOST_ENV_KEYS = [
  "ZSWARM_BIN",
  "ZSWARM_PATH",
  "ZSWARM_TMP",
  "ZSWARM_STATE_DIR",
  "ZSWARM_BUS",
  "ZSWARM_BUS_PLUGIN",
  "ZSWARM_CACHE_TTL_MS",
  "ZSWARM_SESSION",
  "ZELLIJ_SOCKET_DIR",
  "ZELLIJ_TMP_DIR",
  "ZELLIJ_CONFIG_DIR",
  "TEMP",
  "TMP",
  "PATH",
] as const;

const CONTROLLER_ENV_KEYS = [
  "ZSWARM_SERVE",
  "ZSWARM_SSH",
  "ZSWARM_SSH_OPTS",
  "ZSWARM_SSH_MODE",
  "ZSWARM_SSH_BIN",
  "ZSWARM_REMOTE_BIN",
  "ZSWARM_REMOTE_SHELL",
] as const;

const PS_PREAMBLE = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false",
  "function Get-ZswarmIdentity {",
  "  $id = [System.Security.Principal.WindowsIdentity]::GetCurrent()",
  "  if (-not $id -or [string]::IsNullOrWhiteSpace($id.Name)) {",
  "    throw 'cannot resolve the current Windows account for the Interactive logon task'",
  "  }",
  "  return $id.Name",
  "}",
  "function Write-ZswarmJson($obj) {",
  "  $json = $obj | ConvertTo-Json -Compress -Depth 6",
  "  [Console]::Out.Write($json)",
  "}",
  `function Get-ZswarmTask { Get-ScheduledTask -TaskName '${SERVE_TASK_NAME}' -ErrorAction Stop }`,
  "function Test-ZswarmMissing($err) {",
  "  return $err.CategoryInfo.Category -eq 'ObjectNotFound' -or ([string]$err.FullyQualifiedErrorId -match 'ObjectNotFound')",
  "}",
].join("\n");

export type ServeTaskAction = "inspect" | "register" | "start" | "stop" | "unregister";

export type ServePowerShellExec = (
  script: string,
  options: { timeoutMs: number; signal?: AbortSignal },
) => Promise<{ code: number; stdout: string; stderr: string }>;

export type ServeCliLaunch = {
  execPath: string;
  scriptPath: string;
};

export type ServeInstallInput = ServeInstallDeps & {
  listen?: string;
  token?: string;
  env?: NodeJS.ProcessEnv;
  session?: string | null;
  timeoutMs?: number;
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export type ServeInstallSuccess = {
  installed: true;
  ready: true;
  running: true;
  task: string;
  listen: string;
  command: string;
  principal: { userId: string; logonType: string; runLevel: string };
  server: ServeHelloData;
  session: string | null;
  sessions: string[];
  warning?: string;
  inspection: { checks: DoctorCheck[] };
};

const REMEDY = {
  notReady:
    "Registration/start was accepted, but authenticated hello and host inspection did not prove this installation is ready. Retry serve --install or inspect with zswarm doctor; serve --clear removes the owned task. Install does not kill unrelated processes.",
  stale:
    "A listener answered on this port but did not present this installation's launch identity. Install does not kill arbitrary node processes or port owners. Stop the owned zswarm-serve task (serve --clear) or free the port, then retry.",
  session:
    "Start the requested Zellij session on the desktop account that owns the crew, then retry serve --install --session <name> or zswarm doctor --session <name>.",
  ipc:
    "The installed server could not see the desktop Zellij IPC. Confirm the logon task runs as the already-logged-in desktop account (Interactive/Limited) and that ZSWARM_TMP points at that TEMP.",
  cli:
    "Cannot resolve a zswarm CLI launcher for the logon task. process.argv[1] in MCP is the MCP entrypoint, not the CLI. Set ZSWARM_SERVE_CLI to the CLI script (cli.js / zswarm.mjs), or run `zswarm serve --install` from the CLI.",
  owner:
    "An existing zswarm-serve task belongs to a different Windows account. Install does not overwrite another user's task. Run --install as the desktop account that owns the crew, or --clear from that account.",
  interactive:
    "This task requires an already logged-in interactive desktop session (LogonType Interactive, RunLevel Limited). It is not a headless boot/SYSTEM service.",
  token:
    "Set the same ZSWARM_SERVE_TOKEN on the server and this caller. The token is stored in the task action (readable by this user and administrators), not encrypted; reinstall to rotate.",
} as const;

export function looksLikeMcpEntrypoint(scriptPath: string): boolean {
  const base = basename(scriptPath).toLowerCase();
  return (
    base === "mcp-server.js" ||
    base === "mcp-server.mjs" ||
    base === "mcp-server.cjs" ||
    base === "zswarm-mcp" ||
    base === "zswarm-mcp.js" ||
    base === "zswarm-mcp.mjs" ||
    base === "zswarm-mcp.cjs" ||
    base === "zswarm-mcp.cmd"
  );
}

export function looksLikeCliEntrypoint(scriptPath: string): boolean {
  const base = basename(scriptPath).toLowerCase();
  if (base.endsWith(".cmd") || base.endsWith(".bat")) return false;
  return (
    base === "cli.js" ||
    base === "cli.mjs" ||
    base === "cli.cjs" ||
    base === "zswarm" ||
    base === "zswarm.js" ||
    base === "zswarm.mjs" ||
    base === "zswarm.cjs"
  );
}

function fileExists(path: string): boolean {
  try {
    return Boolean(path) && existsSync(path);
  } catch {
    return false;
  }
}

function resolveFromRequire(fromFile: string, spec: string): string | undefined {
  try {
    const href = isAbsolute(fromFile) ? pathToFileURL(fromFile).href : fromFile;
    return createRequire(href).resolve(spec);
  } catch {
    return undefined;
  }
}

function firstExisting(paths: Array<string | undefined>): string | undefined {
  for (const path of paths) {
    if (path && looksLikeCliEntrypoint(path) && fileExists(path)) return path;
  }
  return undefined;
}

/**
 * Resolve node + CLI script for the logon task. MCP argv[1] is never installed.
 */
export function resolveServeCliLaunch(input: {
  execPath?: string;
  scriptPath?: string;
  argv?: string[];
  env?: NodeJS.ProcessEnv;
}): ServeCliLaunch {
  const execPath = input.execPath ?? process.execPath;
  if (!execPath) {
    throw new ZellijError("usage", "cannot resolve node executable for the logon task");
  }
  const argv = input.argv ?? process.argv;
  const envCli = input.env?.ZSWARM_SERVE_CLI?.trim();
  const explicit = input.scriptPath?.trim();
  if (explicit) {
    if (looksLikeMcpEntrypoint(explicit)) {
      throw new ZellijError(
        "usage",
        `${REMEDY.cli} (${explicit} looks like zswarm-mcp)`,
      );
    }
    if (!looksLikeCliEntrypoint(explicit) || !fileExists(explicit)) {
      throw new ZellijError(
        "usage",
        `cannot use ${explicit} as the zswarm CLI launcher for serve --install`,
      );
    }
    return { execPath, scriptPath: explicit };
  }
  if (envCli) {
    if (looksLikeMcpEntrypoint(envCli)) {
      throw new ZellijError("usage", `${REMEDY.cli} (ZSWARM_SERVE_CLI points at MCP)`);
    }
    if (!looksLikeCliEntrypoint(envCli) || !fileExists(envCli)) {
      throw new ZellijError(
        "usage",
        `ZSWARM_SERVE_CLI is not a usable zswarm CLI script (${envCli})`,
      );
    }
    return { execPath, scriptPath: envCli };
  }
  const argvScript = typeof argv[1] === "string" ? argv[1] : "";
  if (argvScript && looksLikeMcpEntrypoint(argvScript)) {
    const sibling = firstExisting([
      join(dirname(argvScript), "zswarm.mjs"),
      join(dirname(argvScript), "zswarm.js"),
      join(dirname(argvScript), "zswarm"),
      join(dirname(argvScript), "..", "..", "cli", "dist", "cli.js"),
      join(dirname(argvScript), "..", "..", "cli", "dist", "cli.mjs"),
      resolveFromRequire(argvScript, "@zswarm/cli"),
    ]);
    if (sibling) return { execPath, scriptPath: sibling };
    throw new ZellijError("usage", REMEDY.cli);
  }
  if (argvScript && looksLikeCliEntrypoint(argvScript) && fileExists(argvScript)) {
    return { execPath, scriptPath: argvScript };
  }
  throw new ZellijError(
    "usage",
    "cannot resolve a zswarm CLI launcher for the logon task; set ZSWARM_SERVE_CLI or run serve --install from the CLI",
  );
}

/** Host Zellij/IPC env for the task child; controller routing is stripped. */
export function serveTaskChildEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of HOST_ENV_KEYS) {
    const raw = key === "PATH" ? env.PATH ?? env.Path : env[key];
    const value = typeof raw === "string" ? raw.trim() : "";
    if (value) out[key] = value;
  }
  for (const key of CONTROLLER_ENV_KEYS) delete out[key];
  return out;
}

export function sameWindowsAccount(a: string, b: string): boolean {
  const norm = (s: string) => s.trim().replace(/\//g, "\\").toLowerCase();
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const parts = (s: string) => {
    const local = s.includes("@") ? s.slice(0, s.indexOf("@")) : s;
    const bits = local.split("\\");
    return { domain: bits.length > 1 ? bits[0]! : "", user: bits[bits.length - 1]! };
  };
  const aa = parts(na);
  const bb = parts(nb);
  if (!aa.user || aa.user !== bb.user) return false;
  if (!aa.domain || !bb.domain) return true;
  return aa.domain === bb.domain;
}

function privilegedAccount(userId: string): boolean {
  return /(?:^|\\)(system|local service|network service)$/i.test(userId.trim()) ||
    /^nt authority\\/i.test(userId.trim());
}

export function buildServeTaskScript(
  action: ServeTaskAction,
  params: { command?: string } = {},
): string {
  if (action === "inspect") {
    return [
      PS_PREAMBLE,
      "try {",
      "  $task = Get-ZswarmTask",
      "} catch {",
      "  if (Test-ZswarmMissing $_) {",
      "    Write-ZswarmJson @{ exists = $false; currentUser = (Get-ZswarmIdentity) }",
      "    exit 0",
      "  }",
      "  throw",
      "}",
      "$action = @($task.Actions)[0]",
      "$principal = $task.Principal",
      "Write-ZswarmJson @{",
      "  exists = $true",
      "  currentUser = (Get-ZswarmIdentity)",
      "  taskName = [string]$task.TaskName",
      "  state = [string]$task.State",
      "  userId = [string]$principal.UserId",
      "  logonType = [string]$principal.LogonType",
      "  runLevel = [string]$principal.RunLevel",
      "  execute = [string]$action.Execute",
      "  arguments = [string]$action.Arguments",
      "}",
    ].join("\n");
  }
  if (action === "register") {
    const command = params.command ?? "";
    const commandB64 = Buffer.from(command, "utf8").toString("base64");
    return [
      PS_PREAMBLE,
      `$cmd = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${commandB64}'))`,
      "$userId = Get-ZswarmIdentity",
      "$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument ('/c ' + $cmd)",
      "$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited",
      "$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId",
      `Register-ScheduledTask -TaskName '${SERVE_TASK_NAME}' -Action $action -Principal $principal -Trigger $trigger -Force | Out-Null`,
      "Write-ZswarmJson @{ registered = $true; userId = $userId; logonType = 'Interactive'; runLevel = 'Limited'; taskName = '" +
        SERVE_TASK_NAME +
        "' }",
    ].join("\n");
  }
  if (action === "start") {
    return [
      PS_PREAMBLE,
      `Start-ScheduledTask -TaskName '${SERVE_TASK_NAME}'`,
      "Write-ZswarmJson @{ started = $true; taskName = '" + SERVE_TASK_NAME + "' }",
    ].join("\n");
  }
  if (action === "stop") {
    return [
      PS_PREAMBLE,
      "try {",
      `  Stop-ScheduledTask -TaskName '${SERVE_TASK_NAME}'`,
      "} catch {",
      "  if (-not (Test-ZswarmMissing $_)) { throw }",
      "}",
      "Write-ZswarmJson @{ stopped = $true; taskName = '" + SERVE_TASK_NAME + "' }",
    ].join("\n");
  }
  return [
    PS_PREAMBLE,
    "try {",
    `  Stop-ScheduledTask -TaskName '${SERVE_TASK_NAME}' -ErrorAction SilentlyContinue`,
    "} catch { }",
    "try {",
    `  Unregister-ScheduledTask -TaskName '${SERVE_TASK_NAME}' -Confirm:$false`,
    "} catch {",
    "  if (Test-ZswarmMissing $_) {",
    "    Write-ZswarmJson @{ cleared = $true; missing = $true; taskName = '" + SERVE_TASK_NAME + "' }",
    "    exit 0",
    "  }",
    "  throw",
    "}",
    "Write-ZswarmJson @{ cleared = $true; taskName = '" + SERVE_TASK_NAME + "' }",
  ].join("\n");
}

function runPowerShellDefault(
  script: string,
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<{ code: number; stdout: string; stderr: string }> {
  const timeout = Math.max(1, Math.floor(options.timeoutMs));
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        encodePowerShellCommand(script),
      ],
      {
        windowsHide: true,
        timeout,
        signal: options.signal,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as { code?: unknown }).code === "number"
            ? (error as { code: number }).code
            : error
              ? 1
              : 0;
        resolve({
          code,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
        });
      },
    );
  });
}

function parseTaskJson(stdout: string, token: string): Record<string, unknown> {
  const text = stdout.trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end < start) {
    throw new ZellijError(
      "zellij_failed",
      `serve task helper returned no JSON (${redactServeSecret(text.slice(0, 200) || "no output", token)})`,
    );
  }
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new ZellijError(
      "zellij_failed",
      "serve task helper returned invalid JSON",
    );
  }
}

function serveInstallToken(input: { token?: string; env?: NodeJS.ProcessEnv }): string {
  const raw =
    input.token ??
    (input.env ? input.env.ZSWARM_SERVE_TOKEN : process.env.ZSWARM_SERVE_TOKEN);
  const secret = raw?.trim() ?? "";
  if (!secret) {
    throw new ZellijError(
      "serve_auth",
      "zswarm serve requires ZSWARM_SERVE_TOKEN; another local OS user can connect to 127.0.0.1",
    );
  }
  return secret;
}

function scrubSecrets<T>(value: T, token: string): T {
  if (!token) return value;
  if (typeof value === "string") return redactServeSecret(value, token) as T;
  if (Array.isArray(value)) return value.map((item) => scrubSecrets(item, token)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      out[key] = scrubSecrets(nested, token);
    }
    return out as T;
  }
  return value;
}

function taskRunning(state: string | undefined): boolean {
  return (state ?? "").toLowerCase() === "running";
}

function commandFromArguments(raw: string | undefined): string {
  const text = raw?.trim() ?? "";
  if (text.toLowerCase().startsWith("/c ")) return text.slice(3).trim();
  return text;
}

function taskMatchesCommand(argumentsText: string | undefined, command: string): boolean {
  return commandFromArguments(argumentsText) === command;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function liveSessionsFrom(checks: DoctorCheck[]): string[] {
  const row = checks.find((item) => item.id === "zellij_sessions");
  const live = row?.detail?.live;
  if (!Array.isArray(live)) return [];
  return live.filter((name): name is string => typeof name === "string" && name.length > 0);
}

function checkById(checks: DoctorCheck[], id: string): DoctorCheck | undefined {
  return checks.find((item) => item.id === id);
}

function evaluateHostReadiness(
  checks: DoctorCheck[],
  explicitSession: string | null,
): {
  ready: boolean;
  phase?: string;
  cause?: string;
  remedy?: string;
  warning?: string;
  session: string | null;
  sessions: string[];
} {
  const sessions = liveSessionsFrom(checks);
  const sessionRow = checkById(checks, "session");
  const sessionName =
    typeof sessionRow?.detail.session === "string" ? sessionRow.detail.session : explicitSession;

  const failRow = (row: DoctorCheck | undefined, phase: string) =>
    row
      ? {
          ready: false as const,
          phase,
          cause: row.code,
          remedy: row.remedy ?? REMEDY.notReady,
          session: sessionName,
          sessions,
        }
      : null;

  const binary = checkById(checks, "zellij_binary");
  if (binary?.state === "fail") return failRow(binary, "host")!;
  const ipc = checkById(checks, "zellij_ipc");
  if (ipc?.state === "fail") {
    return {
      ready: false,
      phase: "host",
      cause: ipc.code,
      remedy: ipc.remedy ?? REMEDY.ipc,
      session: sessionName,
      sessions,
    };
  }
  const listed = checkById(checks, "zellij_sessions");
  if (listed?.state === "fail") return failRow(listed, "host")!;
  const hostRequest = checkById(checks, "host_request");
  if (hostRequest?.state === "fail") return failRow(hostRequest, "host")!;

  if (explicitSession) {
    const present =
      sessionRow?.state === "ok" &&
      (sessionRow.code === "session_present" || sessions.includes(explicitSession));
    if (!present) {
      return {
        ready: false,
        phase: "session",
        cause: sessionRow?.code === "session_missing" ? "session_missing" : sessionRow?.code ?? "session_missing",
        remedy: sessionRow?.remedy ?? REMEDY.session,
        session: explicitSession,
        sessions,
      };
    }
    return { ready: true, session: explicitSession, sessions };
  }

  const empty = sessions.length === 0 || listed?.code === "sessions_none";
  if (empty) {
    return {
      ready: true,
      session: null,
      sessions,
      warning:
        "Serve is authenticated and can list sessions, but no live Zellij session is visible. This is a healthy server, not a ready crew. Pass --session once the desktop crew is running.",
    };
  }
  return { ready: true, session: sessionName, sessions };
}

function notReadyError(
  message: string,
  details: Record<string, unknown>,
  token: string,
  code = SERVE_NOT_READY_CODE,
): ZellijError {
  return new ZellijError(code, message, scrubSecrets(details, token));
}

async function runTask(
  action: ServeTaskAction,
  input: {
    run: ServePowerShellExec;
    timeoutMs: number;
    signal?: AbortSignal;
    token: string;
    command?: string;
  },
): Promise<Record<string, unknown>> {
  const script = buildServeTaskScript(action, { command: input.command });
  const result = await input.run(script, {
    timeoutMs: input.timeoutMs,
    signal: input.signal,
  });
  if (result.code !== 0) {
    throw new ZellijError(
      "zellij_failed",
      `serve --${action === "unregister" ? "clear" : "install"} ${action} failed: ${redactServeSecret(
        (result.stderr || result.stdout).trim() || "no output",
        input.token,
      )}`,
    );
  }
  return parseTaskJson(result.stdout, input.token);
}

function remainingOf(deadline: number, now: () => number): number {
  return Math.max(0, deadline - now());
}

async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
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
  });
}

/**
 * Register/update the current-user Interactive logon task and wait until the
 * requested server instance is authenticated and the host crew is visible.
 */
export async function installServeLogon(
  input: ServeInstallInput = {},
): Promise<ServeInstallSuccess> {
  if ((input.platform ?? process.platform) !== "win32") {
    throw new ZellijError(
      "usage",
      "serve --install registers a Windows logon task; on Unix start `zswarm serve --listen` in the session that owns Zellij",
    );
  }
  const timeoutMs = Math.max(1, Math.floor(input.timeoutMs ?? DEFAULT_SERVE_INSTALL_TIMEOUT_MS));
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? ((ms: number) => defaultSleep(ms, input.signal));
  const deadline = now() + timeoutMs;
  const remaining = () => remainingOf(deadline, now);
  const env = input.env ?? process.env;
  const { host, label } = parseListenAddress(input.listen);
  if (!isLoopbackHost(host)) {
    throw new ZellijError(
      "serve_auth",
      `zswarm serve only listens on loopback (127.0.0.1 / ::1); off-machine access is an SSH tunnel to 127.0.0.1 (${host} refused)`,
    );
  }
  const token = serveInstallToken(input);
  throwIfAborted(input.signal);
  if (remaining() <= 0) {
    throw notReadyError("serve --install timed out before task mutation", {
      installed: false,
      ready: false,
      running: false,
      phase: "inspect",
      cause: "timeout",
      listen: label,
      task: SERVE_TASK_NAME,
    }, token, "timeout");
  }

  const launch = resolveServeCliLaunch({
    execPath: input.execPath,
    scriptPath: input.scriptPath,
    argv: input.argv,
    env,
  });
  const launchId = (input.launchId ?? randomUUID()).trim();
  const childEnv = {
    ...serveTaskChildEnv(env),
    [SERVE_LAUNCH_ID_ENV]: launchId,
  };
  const command = serveLogonCommand(launch.execPath, launch.scriptPath, label, token, childEnv);
  const redactedCommand = redactServeSecret(command, token);
  const run = input.runPowerShell ?? runPowerShellDefault;
  const probe = input.probeServe ?? probeServe;
  const call = input.callServe ??
    ((target: string, args: Record<string, unknown>, options: CallServeOptions) =>
      callServe(target, args, options));
  const explicitSession = input.session?.trim() || null;
  const psBound = () => Math.max(1, Math.min(20_000, remaining()));

  const partial = (extra: Record<string, unknown>): Record<string, unknown> =>
    scrubSecrets(
      {
        installed: false,
        ready: false,
        running: false,
        task: SERVE_TASK_NAME,
        listen: label,
        command: redactedCommand,
        ...extra,
      },
      token,
    );

  throwIfAborted(input.signal);
  const inspected = await runTask("inspect", {
    run,
    timeoutMs: psBound(),
    signal: input.signal,
    token,
  });
  const exists = inspected.exists === true;
  const currentUser = asString(inspected.currentUser);
  const existingUser = asString(inspected.userId);
  if (exists && currentUser && existingUser && !sameWindowsAccount(currentUser, existingUser)) {
    throw notReadyError(
      `serve --install will not overwrite ${SERVE_TASK_NAME} owned by ${existingUser}`,
      {
        ...partial({
          phase: "inspect",
          cause: SERVE_TASK_OWNED_CODE,
          remedy: REMEDY.owner,
          principal: { userId: existingUser },
          currentUser,
        }),
      },
      token,
      SERVE_TASK_OWNED_CODE,
    );
  }
  if (exists && privilegedAccount(existingUser)) {
    throw notReadyError(
      `serve --install will not overwrite ${SERVE_TASK_NAME} owned by ${existingUser}`,
      {
        ...partial({
          phase: "inspect",
          cause: SERVE_TASK_OWNED_CODE,
          remedy: REMEDY.owner,
          principal: { userId: existingUser },
        }),
      },
      token,
      SERVE_TASK_OWNED_CODE,
    );
  }

  const execute = asString(inspected.execute);
  const alreadyRunning = exists && taskRunning(asString(inspected.state));
  const matches =
    exists &&
    execute.toLowerCase() === "cmd.exe" &&
    taskMatchesCommand(asString(inspected.arguments), command) &&
    (!asString(inspected.logonType) || asString(inspected.logonType).toLowerCase() === "interactive");
  const needsUpdate = !exists || !matches;
  let installed = exists && matches;
  let principal = {
    userId: existingUser || currentUser,
    logonType: asString(inspected.logonType) || "Interactive",
    runLevel: asString(inspected.runLevel) || "Limited",
  };

  if (needsUpdate) {
    throwIfAborted(input.signal);
    if (remaining() <= 0) {
      throw notReadyError("serve --install timed out before registering the task", {
        ...partial({ phase: "register", cause: "timeout", remedy: REMEDY.notReady }),
      }, token, "timeout");
    }
    if (alreadyRunning) {
      await runTask("stop", { run, timeoutMs: psBound(), signal: input.signal, token });
    }
    throwIfAborted(input.signal);
    try {
      const registered = await runTask("register", {
        run,
        timeoutMs: psBound(),
        signal: input.signal,
        token,
        command,
      });
      installed = true;
      principal = {
        userId: asString(registered.userId) || principal.userId,
        logonType: asString(registered.logonType) || "Interactive",
        runLevel: asString(registered.runLevel) || "Limited",
      };
    } catch (err) {
      if (err instanceof ZellijError && err.code === "cancelled") throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw notReadyError(message, {
        ...partial({
          phase: "register",
          cause: "register_failed",
          stopped: alreadyRunning,
          remedy:
            "Task mutation was interrupted; inspect the zswarm-serve task. Install does not claim rollback.",
        }),
      }, token, err instanceof ZellijError ? err.code : "zellij_failed");
    }
    throwIfAborted(input.signal);
    if (remaining() <= 0) {
      throw notReadyError("serve --install registered the task but timed out before starting it", {
        ...partial({
          installed: true,
          phase: "start",
          cause: "timeout",
          principal,
          remedy: REMEDY.notReady,
        }),
      }, token, "timeout");
    }
    try {
      await runTask("start", { run, timeoutMs: psBound(), signal: input.signal, token });
    } catch (err) {
      if (err instanceof ZellijError && err.code === "cancelled") throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw notReadyError(message, {
        ...partial({
          installed: true,
          phase: "start",
          cause: "start_failed",
          principal,
          remedy: REMEDY.notReady,
        }),
      }, token, err instanceof ZellijError ? err.code : "zellij_failed");
    }
  } else if (!alreadyRunning) {
    throwIfAborted(input.signal);
    if (remaining() <= 0) {
      throw notReadyError("serve --install timed out before starting the existing task", {
        ...partial({
          installed: true,
          phase: "start",
          cause: "timeout",
          principal,
          remedy: REMEDY.notReady,
        }),
      }, token, "timeout");
    }
    await runTask("start", { run, timeoutMs: psBound(), signal: input.signal, token });
    installed = true;
  }

  let lastCause = "serve_unreachable";
  let lastPhase = "hello";
  let lastRemedy: string = REMEDY.notReady;
  let lastServer: ServeHelloData | undefined;
  let lastInspection: DoctorCheck[] | undefined;
  let lastSessions: string[] = [];
  let probes = 0;
  const known = () =>
    partial({
      installed: true,
      principal,
      phase: lastPhase,
      cause: lastCause,
      remedy: lastRemedy,
      ...(lastServer ? { server: lastServer } : {}),
      ...(lastInspection ? { inspection: { checks: lastInspection } } : {}),
      sessions: lastSessions,
      session: explicitSession,
    });

  while (remaining() > 0 && probes < 64) {
    throwIfAborted(input.signal);
    probes += 1;
    const helloBudget = Math.max(1, Math.min(SERVE_HELLO_TIMEOUT_MS, remaining()));
    const hello = await probe(label, {
      token,
      timeoutMs: helloBudget,
      signal: input.signal,
    } satisfies ProbeServeOptions);
    if (!hello.ok) {
      if (hello.error.code === "cancelled") {
        throw notReadyError("serve --install cancelled during hello", known(), token, "cancelled");
      }
      lastPhase = "hello";
      lastCause = hello.error.code;
      lastRemedy =
        hello.error.code === "serve_unauthorized"
          ? REMEDY.token
          : hello.error.code === "serve_unreachable" || hello.error.code === "timeout"
            ? REMEDY.notReady
            : hello.error.message;
      if (remaining() <= 0) break;
      await sleep(Math.min(100, remaining()));
      continue;
    }
    const server = hello.data as ServeHelloData;
    lastServer = {
      protocol: server.protocol,
      serverId: server.serverId,
      hostname: server.hostname,
      platform: server.platform,
      version: server.version,
      capabilities: [...server.capabilities],
      ...(server.launchId ? { launchId: server.launchId } : {}),
    };
    if (server.protocol !== SERVE_PROTOCOL) {
      lastPhase = "hello";
      lastCause = "serve_incompatible";
      lastRemedy = `This serve protocol is not supported by this client (got ${server.protocol}).`;
      await sleep(Math.min(100, remaining()));
      continue;
    }
    if (server.launchId !== launchId) {
      lastPhase = "hello";
      lastCause = "stale_listener";
      lastRemedy = REMEDY.stale;
      if (remaining() <= 0) break;
      await sleep(Math.min(100, remaining()));
      continue;
    }
    throwIfAborted(input.signal);
    if (remaining() <= 0) break;
    const hostResult = await call(label, hostDoctorRequest(remaining(), explicitSession), {
      timeoutMs: Math.max(1, remaining()),
      token,
      signal: input.signal,
    });
    if (!hostResult.ok && hostResult.error.code === "cancelled") {
      throw notReadyError("serve --install cancelled during host inspection", known(), token, "cancelled");
    }
    if (!hostResult.ok && hostResult.error.code === "timeout") {
      lastPhase = "host";
      lastCause = "timeout";
      lastRemedy = REMEDY.notReady;
      const mergedTimeout = mergeHostReply(hostResult);
      lastInspection = mergedTimeout.checks.length ? coverHostReport(mergedTimeout.checks, explicitSession) : lastInspection;
      if (remaining() <= 0) break;
      await sleep(Math.min(100, remaining()));
      continue;
    }
    const merged = mergeHostReply(hostResult);
    if (merged.unsupported) {
      lastPhase = "host";
      lastCause = "doctor_unsupported";
      lastRemedy =
        "This serve peer does not implement doctor host inspection. Upgrade zswarm serve on the crew host, then retry.";
      await sleep(Math.min(100, remaining()));
      continue;
    }
    if (merged.invalid) {
      lastPhase = "host";
      lastCause = "host_report_invalid";
      lastRemedy =
        "Authenticated hello succeeded, but the host doctor reply was missing or malformed. Upgrade zswarm serve and retry.";
      if (remaining() <= 0) break;
      await sleep(Math.min(100, remaining()));
      continue;
    }
    const checks = coverHostReport(merged.checks, explicitSession);
    lastInspection = checks;
    lastSessions = liveSessionsFrom(checks);
    const verdict = evaluateHostReadiness(checks, explicitSession);
    if (verdict.ready) {
      const data: ServeInstallSuccess = {
        installed: true,
        ready: true,
        running: true,
        task: SERVE_TASK_NAME,
        listen: label,
        command: redactedCommand,
        principal,
        server: lastServer,
        session: verdict.session,
        sessions: verdict.sessions,
        inspection: { checks },
      };
      if (verdict.warning) data.warning = verdict.warning;
      return scrubSecrets(data, token);
    }
    lastPhase = verdict.phase ?? "host";
    lastCause = verdict.cause ?? SERVE_NOT_READY_CODE;
    lastRemedy = verdict.remedy ?? REMEDY.notReady;
    const conclusive =
      lastCause === "session_missing" ||
      lastCause === "ipc_failed" ||
      lastCause === "zellij_missing" ||
      lastCause === "zellij_wrong_bin" ||
      lastCause === "zellij_incompatible";
    if (conclusive) {
      throw notReadyError(
        `serve --install registered ${SERVE_TASK_NAME} but it is not ready (${lastCause})`,
        known(),
        token,
      );
    }
    if (remaining() <= 0) break;
    await sleep(Math.min(100, remaining()));
  }

  throwIfAborted(input.signal);
  const code = lastCause === "cancelled" ? "cancelled" : remaining() <= 0 || lastCause === "timeout" ? "timeout" : SERVE_NOT_READY_CODE;
  throw notReadyError(
    code === "timeout"
      ? "serve --install timed out waiting for authenticated readiness"
      : `serve --install registered ${SERVE_TASK_NAME} but it is not ready (${lastCause})`,
    known(),
    token,
    code === SERVE_NOT_READY_CODE ? SERVE_NOT_READY_CODE : code,
  );
}

export async function uninstallServeLogon(
  input: ServeInstallInput = {},
): Promise<{ task: string; cleared: true; stopped?: boolean; missing?: boolean }> {
  if ((input.platform ?? process.platform) !== "win32") {
    throw new ZellijError("usage", "serve --clear is Windows-only");
  }
  const timeoutMs = Math.max(1, Math.floor(input.timeoutMs ?? DEFAULT_SERVE_INSTALL_TIMEOUT_MS));
  const token = input.token?.trim() || input.env?.ZSWARM_SERVE_TOKEN?.trim() || "none";
  const run = input.runPowerShell ?? runPowerShellDefault;
  throwIfAborted(input.signal);
  const inspected = await runTask("inspect", {
    run,
    timeoutMs,
    signal: input.signal,
    token,
  });
  if (inspected.exists === true) {
    const currentUser = asString(inspected.currentUser);
    const existingUser = asString(inspected.userId);
    if (currentUser && existingUser && !sameWindowsAccount(currentUser, existingUser)) {
      throw notReadyError(
        `serve --clear will not remove ${SERVE_TASK_NAME} owned by ${existingUser}`,
        {
          installed: true,
          ready: false,
          task: SERVE_TASK_NAME,
          phase: "inspect",
          cause: SERVE_TASK_OWNED_CODE,
          remedy: REMEDY.owner,
          principal: { userId: existingUser },
        },
        token,
        SERVE_TASK_OWNED_CODE,
      );
    }
  }
  const cleared = await runTask("unregister", {
    run,
    timeoutMs,
    signal: input.signal,
    token,
  });
  return {
    task: SERVE_TASK_NAME,
    cleared: true,
    stopped: inspected.exists === true,
    ...(cleared.missing === true ? { missing: true } : {}),
  };
}
