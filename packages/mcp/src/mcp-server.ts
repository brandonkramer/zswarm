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

const serveTunnels = createServeTunnelManager({ persistIdle: true });
let shuttingDown = false;
const shutdownTunnels = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  void serveTunnels.closeAll();
};

const server = new Server(
  { name: "zswarm", version },
  { capabilities: { tools: {} } },
);

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

  const result = await dispatchZswarm(args, undefined, {
    signal: extra.signal,
    serveTunnels,
  });
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(result, null, 2) },
    ],
    isError: !result.ok,
  };
});

const transport = new StdioServerTransport();
transport.onclose = shutdownTunnels;
transport.onerror = shutdownTunnels;
process.stdin.on("end", shutdownTunnels);
process.stdin.on("close", shutdownTunnels);
process.once("SIGINT", shutdownTunnels);
process.once("SIGTERM", shutdownTunnels);
await server.connect(transport);
