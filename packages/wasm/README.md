# @zswarm/wasm

Compiled Zellij event-bus plugin for [`@zswarm/core`](https://www.npmjs.com/package/@zswarm/core).

Zellij pushes pane and tab changes into it, so `list` and `status` read state
from memory instead of spawning a process per question. Installed with
`@zswarm/core`; every path falls back to polling if it is missing.

## Install

Comes in as a dependency of `@zswarm/core` — you do not install it directly.
Activate it once per machine:

```bash
zswarm bus --install
```

Override the file with `ZSWARM_BUS_PLUGIN=/abs/path.wasm`.

## Filenames are versioned

Zellij caches a plugin's permission decision per **URL** and silently denies
anything the approved set does not cover. A build that requests a new permission
must ship under a new filename — hence `zswarm-bus-v3.wasm`. Moving the file has
the same effect: re-run `zswarm bus --install --force`.

## Building

Source is the `plugin/zswarm-events` crate in the zSwarm repo; needs Rust.

```bash
pnpm run build:plugin
```

## License

MIT
