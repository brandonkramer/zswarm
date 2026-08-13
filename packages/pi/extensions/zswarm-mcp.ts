/**
 * Bridge MCP tools into pi.
 *
 * pi ships no MCP client on purpose — its position is that a CLI with a README
 * is the better interface. That holds right up until you want one surface that
 * every harness in a crew shares, which is what an MCP server already is. This
 * extension spawns a stdio MCP server, asks it for its tools, and registers
 * each one with pi, so the same tool call works here and in the MCP hosts.
 *
 * It speaks the protocol directly rather than depending on an SDK: an extension
 * is loaded from the project tree and cannot rely on the repo's node_modules
 * being resolvable from wherever pi was started.
 *
 * Configure with ZSWARM_MCP_SERVERS (JSON, same shape as any MCP host config):
 *
 *   {"zswarm":{"command":"/abs/path/to/node","args":["/abs/path/to/server.js"]}}
 *
 * With nothing set it looks for zSwarm's own server in the two places it can
 * actually be, and registers nothing if it is in neither — see defaultServers.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

type ServerSpec = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

type McpTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

/**
 * Where zSwarm's own server might be, in order of confidence.
 *
 * `process.execPath` rather than `"node"`: a host that spawns servers outside
 * your shell inherits no PATH, and the interpreter already running this code is
 * both absolute and known-good.
 *
 * There is deliberately no fallback to a bare relative path. Guessing produces
 * a spawn failure the user has to decode; finding nothing produces a message
 * that names the environment variable that fixes it.
 */
function resolveDependencyServer(): string | null {
  try {
    return createRequire(import.meta.url).resolve("@zswarm/mcp");
  } catch {
    return null; // Not installed; the checkout path or an override covers it.
  }
}

function defaultServers(): Record<string, ServerSpec> {
  const candidates = [
    // A checkout of the zswarm repo, with pi started at its root.
    resolve(process.cwd(), "bin", "launch-mcp.mjs"),
    // Installed as a dependency: @zswarm/mcp exports its server entry, so
    // node resolution finds it wherever the package manager put it.
    resolveDependencyServer(),
  ].filter((entry): entry is string => entry !== null);
  for (const entry of candidates) {
    if (existsSync(entry)) {
      return { zswarm: { command: process.execPath, args: [entry] } };
    }
  }
  return {};
}

/** How long to wait for a server to answer initialize/tools-list before giving up. */
const HANDSHAKE_MS = 20_000;
/** Core wait max is 15 minutes; slack covers framing so the client does not give up first. */
const CALL_MS = 16 * 60_000;

function readServers(): Record<string, ServerSpec> {
  const raw = process.env.ZSWARM_MCP_SERVERS?.trim();
  if (!raw) return defaultServers();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, ServerSpec>;
    }
  } catch {
    // A malformed override should not cost you the default server.
  }
  return defaultServers();
}

/**
 * One stdio MCP server, kept alive for the session.
 *
 * Framing is newline-delimited JSON-RPC. Responses are matched by id because
 * a server may interleave notifications, and stdout can split a message across
 * chunk boundaries — so bytes are buffered until a newline lands.
 */
class McpClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  constructor(
    private readonly name: string,
    private readonly spec: ServerSpec,
    private readonly cwd: string,
  ) {}

  async start(): Promise<McpTool[]> {
    const child = spawn(this.spec.command, this.spec.args ?? [], {
      cwd: this.cwd,
      env: { ...process.env, ...(this.spec.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consume(chunk));
    child.on("error", (err) => this.failAll(err));
    child.on("close", () => this.failAll(new Error(`${this.name} exited`)));

    await this.request(
      "initialize",
      {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "pi", version: "1" },
      },
      HANDSHAKE_MS,
    );
    this.notify("notifications/initialized", {});

    const listed = (await this.request("tools/list", {}, HANDSHAKE_MS)) as {
      tools?: McpTool[];
    };
    return listed.tools ?? [];
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.dispatch(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  private dispatch(line: string): void {
    let message: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      message = JSON.parse(line);
    } catch {
      return; // Servers may log to stdout; ignore anything that is not a message.
    }
    if (typeof message.id !== "number") return;
    const waiter = this.pending.get(message.id);
    if (!waiter) return;
    this.pending.delete(message.id);
    if (message.error) {
      waiter.reject(new Error(message.error.message ?? "MCP error"));
    } else {
      waiter.resolve(message.result);
    }
  }

  private failAll(error: Error): void {
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }

  private send(payload: Record<string, unknown>): void {
    this.child?.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  private request(
    method: string,
    params: unknown,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("Cancelled"));
        return;
      }
      const onAbort = () => {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new Error("Cancelled"));
      };
      const timer = setTimeout(() => {
        this.pending.delete(id);
        signal?.removeEventListener("abort", onAbort);
        reject(new Error(`${this.name} ${method} timed out`));
      }, timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  async call(
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<string> {
    const result = (await this.request(
      "tools/call",
      { name: tool, arguments: args },
      CALL_MS,
      signal,
    )) as { content?: Array<{ type?: string; text?: string }> };
    const text = (result.content ?? [])
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n");
    return text || JSON.stringify(result);
  }

  stop(): void {
    this.child?.kill();
    this.child = null;
  }
}

export default function (pi: ExtensionAPI) {
  const clients: McpClient[] = [];
  /** What each server reported at connect time, for the session_start notice. */
  const registered: Array<{ name: string; count: number; error?: string }> = [];

  /**
   * Connect and register at module load rather than from `session_start`.
   *
   * `/reload` rebinds extensions, but only a session switch, fork, or new
   * session is documented to re-emit `session_start` — so a handler is the
   * wrong place to put the one thing that must happen on every bind. A fresh
   * module instance is created per bind, so this closure runs exactly once
   * each time and needs no idempotence guard.
   *
   * Registration is async because a server's tools are unknown until it has
   * been asked, and the default export cannot await. Tools therefore appear a
   * moment after load; `session_start` reports what landed.
   */
  const connecting = (async () => {
    for (const [name, spec] of Object.entries(readServers())) {
      // No ExtensionContext at load time, so the project root comes from the
      // process — pi is started in the directory it operates on.
      const client = new McpClient(name, spec, process.cwd());
      let tools: McpTool[];
      try {
        tools = await client.start();
      } catch (err) {
        // A missing server is a missing capability, never a broken session.
        const message = err instanceof Error ? err.message : String(err);
        registered.push({ name, count: 0, error: message });
        client.stop();
        continue;
      }
      clients.push(client);
      registered.push({ name, count: tools.length });

      for (const tool of tools) {
        // `server_tool`, unless the server named its tool after itself.
        const toolName = tool.name === name ? name : `${name}_${tool.name}`;
        pi.registerTool({
          name: toolName,
          label: toolName,
          description: tool.description ?? `${tool.name} via the ${name} MCP server`,
          promptSnippet: (tool.description ?? toolName).split(".")[0],
          // An MCP inputSchema is already JSON Schema, which is what the
          // TypeBox helpers produce — so it is handed over unchanged.
          parameters: (tool.inputSchema ?? {
            type: "object",
            properties: {},
          }) as never,
          async execute(_toolCallId, params, signal) {
            const cancelled = () => ({
              content: [{ type: "text" as const, text: "Cancelled" }],
              details: {},
            });
            if (signal?.aborted) return cancelled();
            try {
              const text = await client.call(
                tool.name,
                (params ?? {}) as Record<string, unknown>,
                signal,
              );
              if (signal?.aborted) return cancelled();
              return { content: [{ type: "text", text }], details: {} };
            } catch (err) {
              if (signal?.aborted) return cancelled();
              const message = err instanceof Error ? err.message : String(err);
              return {
                content: [{ type: "text", text: `MCP ${name} error: ${message}` }],
                details: { error: message },
              };
            }
          },
        });
      }
    }
  })();

  // Surface the outcome once there is a UI to surface it to. Awaiting the same
  // promise means this reports rather than repeats the work.
  pi.on("session_start", async (_event, ctx) => {
    await connecting;
    if (registered.length === 0) {
      ctx.ui.notify(
        "No MCP server found. Set ZSWARM_MCP_SERVERS to point at one.",
        "error",
      );
      return;
    }
    for (const entry of registered) {
      if (entry.error) {
        ctx.ui.notify(`MCP ${entry.name} unavailable: ${entry.error}`, "error");
      } else {
        ctx.ui.notify(`MCP ${entry.name}: ${entry.count} tool(s) registered`, "info");
      }
    }
  });

  // Idempotent by construction: the list is emptied as it is drained.
  pi.on("session_shutdown", async () => {
    for (const client of clients) client.stop();
    clients.length = 0;
  });
}
