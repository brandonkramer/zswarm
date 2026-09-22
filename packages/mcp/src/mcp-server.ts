#!/usr/bin/env node
import { createRequire } from "node:module";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  createServeTunnelManager,
  dispatchZswarm,
  mcpInputSchema,
  MCP_TOOL_DESCRIPTION,
} from "@zswarm/core";

const { version } = createRequire(import.meta.url)("../package.json") as {
  version: string;
};

const SHUTDOWN_BOUND_MS = 5_000;
const serveTunnels = createServeTunnelManager({ persistIdle: true });
const requestAborts = new Set<AbortController>();
let inflight = 0;
let shuttingDown = false;
let shutdownPromise: Promise<void> | undefined;

const server = new Server(
  { name: "zswarm", version },
  { capabilities: { tools: {} } },
);

const transport = new StdioServerTransport();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function shutdown(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  shutdownPromise = (async () => {
    for (const ac of requestAborts) ac.abort();
    const bound = Date.now() + SHUTDOWN_BOUND_MS;
    while (inflight > 0 && Date.now() < bound) {
      await sleep(15);
    }
    await serveTunnels.closeAll();
    try {
      await server.close();
    } catch {
      /* already closed */
    }
    try {
      await transport.close();
    } catch {
      /* already closed */
    }
  })();
  await shutdownPromise;
}

function requestShutdown(exitAfter: boolean): void {
  void shutdown().finally(() => {
    if (exitAfter) process.exit(0);
  });
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "zswarm",
      description: MCP_TOOL_DESCRIPTION,
      inputSchema: mcpInputSchema(),
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const name = request.params.name;
  const args = (request.params.arguments ?? {}) as Record<string, unknown>;
  if (name !== "zswarm") {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            ok: false,
            error: { code: "unknown_tool", message: `unknown tool ${name}` },
          }),
        },
      ],
      isError: true,
    };
  }
  if (shuttingDown) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            ok: false,
            error: { code: "cancelled", message: "serve tunnel manager is closed" },
          }),
        },
      ],
      isError: true,
    };
  }

  const ac = new AbortController();
  const onExtraAbort = () => ac.abort();
  extra.signal?.addEventListener("abort", onExtraAbort, { once: true });
  requestAborts.add(ac);
  inflight += 1;
  try {
    const result = await dispatchZswarm(args, undefined, {
      signal: ac.signal,
      serveTunnels,
    });
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(result, null, 2) },
      ],
      isError: !result.ok,
    };
  } finally {
    extra.signal?.removeEventListener("abort", onExtraAbort);
    requestAborts.delete(ac);
    inflight -= 1;
  }
});

transport.onclose = () => {
  requestShutdown(true);
};
transport.onerror = () => {
  requestShutdown(true);
};
process.stdin.on("end", () => {
  requestShutdown(true);
});
process.stdin.on("close", () => {
  requestShutdown(true);
});
process.once("SIGINT", () => {
  requestShutdown(true);
});
process.once("SIGTERM", () => {
  requestShutdown(true);
});
await server.connect(transport);
