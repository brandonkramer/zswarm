# @zswarm/pi

Bridge stdio MCP servers into [pi](https://pi.dev) as native tools. Defaults to zSwarm; point it at any stdio MCP server with `ZSWARM_MCP_SERVERS`.

## Install

```bash
pi install npm:@zswarm/pi
```

From a checkout of this repo:

```bash
pi install -l ./packages/pi
```

`-l` installs into the project (`.pi/settings.json`) rather than your home
directory, and is shareable — pi installs it for anyone who opens the project.

Restart pi after installing. After that `/reload` is enough, since the extension
registers on every bind. On success:

```
[Extensions]
  zswarm-mcp.ts
 MCP zswarm: 1 tool(s) registered
```

## Configure

With nothing set, it looks for zSwarm's own server in the only two places it can
be, in order:

1. `<cwd>/bin/launch-mcp.mjs` — a checkout of the zswarm repo, pi started at its root
2. `@zswarm/mcp` — resolved by name, wherever your package manager put it

`@zswarm/mcp` is a dependency of this package, so a plain
`pi install npm:@zswarm/pi` pulls the server in and step 2 finds it. Nothing to
configure.

Found in neither, it registers nothing and says so. It does not guess a relative
path: a wrong guess becomes a spawn error you have to decode, whereas finding
nothing names the variable that fixes it.

Set `ZSWARM_MCP_SERVERS` to bridge a **different** server — JSON, same shape as
other MCP hosts:

```bash
ZSWARM_MCP_SERVERS='{
  "zswarm": {"command": "/abs/path/to/node", "args": ["/abs/path/to/launch-mcp.mjs"]},
  "other":  {"command": "/abs/path/to/other-server"}
}'
```

Use absolute paths throughout. Hosts that spawn servers outside your shell
inherit no `PATH`, so a bare `node` fails with
`exec: "node": executable file not found in $PATH`. The built-in defaults use
`process.execPath` — the interpreter already running pi — for exactly this
reason.

Tools register as `<server>_<tool>`, or `<tool>` when the names match. A failed server is skipped. Set `ZSWARM_SESSION` if more than one Zellij session is live.

## How it works

On load: spawn each server → `initialize` → `tools/list` → `pi.registerTool()`. A call is `tools/call`. JSON-RPC, no SDK; schemas pass through as-is. Tools may not be ready in the same instant pi starts.

## License

MIT
