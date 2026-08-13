#!/usr/bin/env node
import { createRequire } from "node:module";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  dispatchZswarm,
  mcpInputSchema,
  MCP_TOOL_DESCRIPTION,
} from "@zswarm/core";

const { version } = createRequire(import.meta.url)("../package.json") as {
  version: string;
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

server.setRequestHandler(CallToolRequestSchema, async (request) => {
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

  const result = await dispatchZswarm(args);
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(result, null, 2) },
    ],
    isError: !result.ok,
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
