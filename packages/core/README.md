# @zswarm/core

Zellij client and the shared `dispatchZswarm` ops layer. Everything else is a
thin shell over it. One table in `src/schema.ts` generates the MCP tool schema,
the CLI flags, and the CLI help, so they cannot drift.

## Install

```bash
npm install @zswarm/core
```

From a checkout of this repo:

```bash
npm install ./packages/core
```

Requires Zellij >= 0.42 and Node >= 20.

## Usage

```js
import { dispatchZswarm } from "@zswarm/core";

const result = await dispatchZswarm({ op: "list" });
```

`dispatchZswarm` builds a Zellij client unless you pass one. The result is
`{ ok, data }` or `{ ok: false, error }`.

Ops, env, and the event bus: the [zswarm README](../../README.md).

## License

MIT
