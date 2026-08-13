# @zswarm/mcp

stdio MCP server. One tool named `zswarm` with an `op` enum, dispatched through
`@zswarm/core`.

## Install

```bash
npm install @zswarm/mcp
```

From a checkout of this repo:

```bash
npm install ./packages/mcp
```

Requires Zellij >= 0.42 and Node >= 20. The bin is `zswarm-mcp`.

## Usage

```json
{
  "mcpServers": {
    "zswarm": {
      "command": "/path/to/node",
      "args": ["/path/to/node_modules/@zswarm/mcp/dist/mcp-server.js"],
      "env": { "ZSWARM_SESSION": "<session-name>" }
    }
  }
}
```

```text
zswarm({ op: "list" })
zswarm({ op: "send", to: "terminal_2", body: "ping" })
```

Some MCP hosts spawn servers outside your shell and inherit neither PATH nor
the Zellij environment. Give the interpreter an absolute path and set
`ZSWARM_SESSION`. `ZSWARM_SSH` or `ZSWARM_SERVE` routes the same tool at a
remote crew. Details: the [zswarm README](../../README.md).

## License

MIT
