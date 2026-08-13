import { createServer, connect } from "node:net";
import { execFile } from "node:child_process";
import { ZellijError } from "../errors.js";
import { encodePowerShellCommand } from "../zellij/ipc.js";
import type { OpsResult } from "./types.js";

export const DEFAULT_SERVE_LISTEN = "127.0.0.1:9419";
export const SERVE_TASK_NAME = "zswarm-serve";

export function parseListenAddress(raw: string | undefined): {
  host: string;
  port: number;
  label: string;
} {
  const text = (raw ?? DEFAULT_SERVE_LISTEN).trim() || DEFAULT_SERVE_LISTEN;
  const stripped = text.replace(/^tcp:\/\//i, "");
  const hostPort = stripped.includes("]")
    ? stripped
    : stripped.includes(":")
      ? stripped
      : `127.0.0.1:${stripped}`;
  const colon = hostPort.lastIndexOf(":");
  const host = colon === -1 ? "127.0.0.1" : hostPort.slice(0, colon) || "127.0.0.1";
  const port = Number(colon === -1 ? hostPort : hostPort.slice(colon + 1));
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ZellijError("bad_arg", `listen address is not host:port (${text})`);
  }
  return { host, port, label: `${host}:${port}` };
}

/** Client-side wait: the op's own timeout plus slack, capped at ten minutes. */
export function serveCallTimeout(args: Record<string, unknown>): number {
  const requested = Number(args.timeoutMs);
  const base = Number.isFinite(requested) && requested > 0 ? requested : 60_000;
  return Math.min(Math.max(base + 5_000, 15_000), 10 * 60_000);
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

export function startServe(
  listen: string | undefined,
  dispatch: ServeDispatch,
): Promise<{ label: string; close: () => Promise<void> }> {
  const { host, port } = parseListenAddress(listen);
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => {
      let buf = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        buf += chunk;
        void drain();
      });
      async function drain() {
        let nl = buf.indexOf("\n");
        while (nl !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) {
            let result: OpsResult;
            try {
              const args = JSON.parse(line) as Record<string, unknown>;
              result = await dispatch(args);
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              result = { ok: false, error: { code: "bad_arg", message } };
            }
            socket.write(`${JSON.stringify(result)}\n`);
          }
          nl = buf.indexOf("\n");
        }
      }
    });
    server.on("error", reject);
    server.listen(port, host, () => {
      const addr = server.address();
      const actualPort =
        typeof addr === "object" && addr ? addr.port : port;
      resolve({
        label: `${host}:${actualPort}`,
        close: () =>
          new Promise((done, fail) => {
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
): Promise<OpsResult> {
  const { host, port } = parseServeTarget(target);
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
      socket.write(`${JSON.stringify(args)}\n`);
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
  const { label } = parseListenAddress(input.listen);
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
  const script = `Unregister-ScheduledTask -TaskName '${SERVE_TASK_NAME}' -Confirm:$false -ErrorAction SilentlyContinue`;
  await runPowerShell(script);
  return { task: SERVE_TASK_NAME, cleared: true };
}
