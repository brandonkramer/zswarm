# @zswarm/cli

The `zswarm` command. Same ops as the MCP tool, through `@zswarm/core`. Two
conveniences: the first bare argument is `--to` and the second is `--body` for
`send`; `--key` / `--keys` repeat into an array.

## Install

```bash
npm install -g @zswarm/cli
```

From a checkout of this repo:

```bash
npm install ./packages/cli
```

Requires Zellij >= 0.42 and Node >= 20.

## Usage

```bash
zswarm list
zswarm send terminal_2 ping
zswarm send --to terminal_2 --body ping
zswarm keys --to terminal_2 --key "Ctrl c" --key Esc
```

Prints JSON. No arguments prints usage, generated from the same schema as the
MCP tool.

Ops, env, and the event bus: the [zswarm README](../../README.md).

## License

MIT
