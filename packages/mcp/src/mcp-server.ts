#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { dispatchZswarm } from "@zswarm/core";

const server = new Server(
  { name: "zswarm", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "zswarm",
      description:
        "zSwarm Zellij pane coordination (op=list|send|dump|sessions). list panes, send text into a CLI pane (paste+Enter), dump scrollback. Local Zellij only.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          op: {
            type: "string",
            enum: ["list", "send", "dump", "sessions"],
            description: "list | send | dump | sessions",
          },
          session: {
            type: "string",
            description:
              "Zellij session name (optional if sole live session or ZSWARM_SESSION / ZELLIJ_SESSION_NAME)",
          },
          to: {
            type: "string",
            description:
              "send/dump: pane id (3 / terminal_3) or unique title/command",
          },
          body: {
            type: "string",
            description: "send: message body",
          },
          text: {
            type: "string",
            description: "send: alias for body",
          },
          from: {
            type: "string",
            description: "send: sender label in [zswarm from=…] prefix",
          },
          raw: {
            type: "boolean",
            description: "send: skip peer prefix (default false)",
          },
          full: {
            type: "boolean",
            description: "dump: include full scrollback (default false)",
          },
          max: {
            type: "number",
            description:
              "dump: max text chars (default 8000, keeps tail; 0 = unlimited)",
          },
          head: {
            type: "boolean",
            description: "dump: keep start instead of tail when truncating",
          },
          verbose: {
            type: "boolean",
            description:
              "list/send: include cwd/focus/exited/floating (and pane on send)",
          },
        },
        required: ["op"],
      },
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
