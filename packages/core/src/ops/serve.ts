import { createServer, connect, type Socket } from "node:net";
import { execFile } from "node:child_process";
import { ZellijError } from "../errors.js";
import { encodePowerShellCommand } from "../zellij/ipc.js";
import type { OpsResult } from "./types.js";

export const DEFAULT_SERVE_LISTEN = "127.0.0.1:9419";
export const SERVE_TASK_NAME = "zswarm-serve";
/** One JSONL request; a client that never sends newline cannot grow forever. */
export const SERVE_MAX_REQUEST_BYTES = 1024 * 1024;
/** Drop a socket that never finishes a JSONL line. */
export const SERVE_IDLE_TIMEOUT_MS = 30_000;
/** Concurrent TCP clients, including in-flight wait ops. */
export const SERVE_MAX_CONNECTIONS = 32;
/** Wait/await allow 15 minutes; this is that plus slack. */
export const SERVE_CALL_TIMEOUT_CAP_MS = 16 * 60_000;
const SERVE_TOKEN_FIELD = "serveToken";

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
              let result: OpsResult;
              try {
                const parsed = JSON.parse(line) as Record<string, unknown>;
                const taken = takeServeToken(parsed);
                if (taken.token !== token) {
                  result = unauthorized();
                } else {
                  result = await dispatch(taken.request);
                }
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                result = { ok: false, error: { code: "bad_arg", message } };
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

export function parseServeTarget(raw: string): { host: string; port: number } {
  return parseListenAddress(raw);
}

export function callServe(
  target: string,
  args: Record<string, unknown>,
  timeoutMs = 15_000,
  token?: string,
): Promise<OpsResult> {
  const { host, port } = parseServeTarget(target);
  const payload =
    token && token.trim()
      ? { ...args, [SERVE_TOKEN_FIELD]: token.trim() }
      : args;
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    let buf = "";
    let settled = false;
    const finish = (result: OpsResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish({
        ok: false,
        error: {
          code: "timeout",
          message: `zswarm serve at ${host}:${port} timed out after ${timeoutMs}ms`,
        },
      });
    }, timeoutMs);
    socket.setEncoding("utf8");
    socket.on("error", (err) => {
      finish({
        ok: false,
        error: {
          code: "serve_unreachable",
          message: `cannot reach zswarm serve at ${host}:${port}: ${err.message}`,
        },
      });
    });
    socket.on("data", (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      const line = buf.slice(0, nl).trim();
      try {
        finish(JSON.parse(line) as OpsResult);
      } catch {
        finish({
          ok: false,
          error: { code: "failed", message: `serve returned non-JSON: ${line}` },
        });
      }
    });
    socket.on("connect", () => {
      socket.write(`${JSON.stringify(payload)}\n`);
    });
  });
}

export function serveLogonCommand(
  execPath: string,
  scriptPath: string,
  listen: string,
): string {
  return `"${execPath}" "${scriptPath}" serve --listen ${listen}`;
}

function runPowerShell(script: string): Promise<{ code: number; stdout: string; stderr: string }> {
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
      { windowsHide: true, timeout: 20_000 },
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

export async function installServeLogon(input: {
  listen?: string;
  execPath?: string;
  scriptPath?: string;
  platform?: NodeJS.Platform;
}): Promise<{ task: string; listen: string; command: string }> {
  if ((input.platform ?? process.platform) !== "win32") {
    throw new ZellijError(
      "usage",
      "serve --install registers a Windows logon task; on Unix start `zswarm serve --listen` in the session that owns Zellij",
    );
  }
  const { host, label } = parseListenAddress(input.listen);
  if (!isLoopbackHost(host)) {
    throw new ZellijError(
      "serve_auth",
      `zswarm serve only listens on loopback (127.0.0.1 / ::1); off-machine access is an SSH tunnel to 127.0.0.1 (${host} refused)`,
    );
  }
  const execPath = input.execPath ?? process.execPath;
  const scriptPath = input.scriptPath ?? process.argv[1];
  if (!scriptPath) {
    throw new ZellijError("usage", "cannot resolve the zswarm script path for the logon task");
  }
  const command = serveLogonCommand(execPath, scriptPath, label);
  const commandB64 = Buffer.from(command, "utf8").toString("base64");
  const script = [
    "$cmd = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" +
      commandB64 +
      "'))",
    "$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument \"/c $cmd\"",
    "$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited",
    "$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME",
    `Register-ScheduledTask -TaskName '${SERVE_TASK_NAME}' -Action $action -Principal $principal -Trigger $trigger -Force | Out-Null`,
    `Start-ScheduledTask -TaskName '${SERVE_TASK_NAME}'`,
  ].join("\n");
  const result = await runPowerShell(script);
  if (result.code !== 0) {
    throw new ZellijError(
      "zellij_failed",
      `serve --install failed: ${(result.stderr || result.stdout).trim() || "no output"}`,
    );
  }
  return { task: SERVE_TASK_NAME, listen: label, command };
}

export async function uninstallServeLogon(input: {
  platform?: NodeJS.Platform;
} = {}): Promise<{ task: string; cleared: true }> {
  if ((input.platform ?? process.platform) !== "win32") {
    throw new ZellijError("usage", "serve --clear is Windows-only");
  }
  const script = [
    "$ProgressPreference = 'SilentlyContinue'",
    "try {",
    `  Unregister-ScheduledTask -TaskName '${SERVE_TASK_NAME}' -Confirm:$false`,
    "} catch {",
    "  if ($_.CategoryInfo.Category -eq 'ObjectNotFound') { exit 0 }",
    "  [Console]::Error.Write(($_ | Out-String).Trim())",
    "  exit 1",
    "}",
  ].join("\n");
  const result = await runPowerShell(script);
  if (result.code !== 0) {
    throw new ZellijError(
      "zellij_failed",
      `serve --clear failed: ${(result.stderr || result.stdout).trim() || "no output"}`,
    );
  }
  return { task: SERVE_TASK_NAME, cleared: true };
}
