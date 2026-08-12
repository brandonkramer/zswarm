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
        "zSwarm Zellij pane coordination (op=list|send|dump|wait|keys|interrupt|spawn|close|sessions). List panes, send text into a CLI pane (paste+Enter), block until a pane goes idle or prints a match, send raw keys, open or close panes. Local Zellij only.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          op: {
            type: "string",
            enum: [
              "list",
              "send",
              "dump",
              "wait",
              "keys",
              "interrupt",
              "spawn",
              "close",
              "sessions",
            ],
            description:
              "list | send | dump | wait | keys | interrupt | spawn | close | sessions",
          },
          session: {
            type: "string",
            description:
              "Zellij session name (optional if sole live session or ZSWARM_SESSION / ZELLIJ_SESSION_NAME)",
          },
          to: {
            type: "string",
            description:
              "send/dump/wait/keys/interrupt/close: pane id (3 / terminal_3) or unique title/command",
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
            description: "dump/wait: include full scrollback (default false)",
          },
          max: {
            type: "number",
            description:
              "dump/wait: max text chars (dump 8000, wait 2000; keeps tail, 0 = unlimited)",
          },
          head: {
            type: "boolean",
            description: "dump: keep start instead of tail when truncating",
          },
          for: {
            type: "string",
            enum: ["idle", "match", "either"],
            description:
              "wait: stop on quiet screen, on match, or whichever lands first (default: match if match= given, else idle)",
          },
          match: {
            type: "string",
            description: "wait: text to look for in the pane screen",
          },
          regex: {
            type: "boolean",
            description: "wait: treat match as a regex (default false)",
          },
          ignoreCase: {
            type: "boolean",
            description: "wait: case-insensitive match (default false)",
          },
          idleMs: {
            type: "number",
            description:
              "wait: screen must be unchanged this long to count as idle (default 2000)",
          },
          pollMs: {
            type: "number",
            description: "wait: poll interval (default 600)",
          },
          timeoutMs: {
            type: "number",
            description: "wait: give up after this long (default 60000)",
          },
          keys: {
            anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
            description:
              'keys: key specs, one per array entry — "Ctrl c", "Esc", "F1", "Up". A bare string is one key; comma-separate for several.',
          },
          chars: {
            type: "string",
            description:
              "keys: literal characters to type instead of key specs (no Enter unless enter=true)",
          },
          enter: {
            type: "boolean",
            description: "keys: press Enter after the keys/chars",
          },
          hard: {
            type: "boolean",
            description:
              "interrupt: send Ctrl c instead of the default Esc",
          },
          command: {
            anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
            description:
              "spawn: program to run in the new pane, argv-style (no shell). Empty starts a plain shell.",
          },
          cwd: {
            type: "string",
            description: "spawn: working directory for the new pane",
          },
          name: {
            type: "string",
            description: "spawn: pane (or tab) name",
          },
          direction: {
            type: "string",
            enum: ["right", "left", "up", "down"],
            description: "spawn: split direction",
          },
          floating: {
            type: "boolean",
            description: "spawn: open the pane floating",
          },
          tab: {
            type: "boolean",
            description: "spawn: open a new tab instead of splitting",
          },
          layout: {
            type: "string",
            description: "spawn: layout name for the new tab (tab=true)",
          },
          closeOnExit: {
            type: "boolean",
            description: "spawn: close the pane when its command exits",
          },
          allowSelf: {
            type: "boolean",
            description:
              "send/keys/close: allow targeting zswarm's own pane (default false)",
          },
          force: {
            type: "boolean",
            description: "send/keys: write to a pane whose command has exited",
          },
          verbose: {
            type: "boolean",
            description:
              "list/send/spawn: include cwd/focus/exited/floating (and pane on send/spawn)",
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
