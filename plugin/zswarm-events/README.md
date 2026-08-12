# zswarm-events

Zellij pushes pane and tab state into this plugin as it changes, so `zswarm list`
and `zswarm status` can read the current picture out of memory instead of
spawning `dump-screen` per pane on a timer.

The compiled artifact is committed at `packages/wasm/zswarm-bus-v3.wasm`, so
using the bus needs no Rust. This crate is only for changing it.

## Build

```bash
rustup target add wasm32-wasip1
cargo build --release --target wasm32-wasip1
cp target/wasm32-wasip1/release/zswarm-events.wasm ../../packages/wasm/zswarm-bus-v3.wasm
```

## Run

```bash
zswarm bus --install         # loads it in a pane, approve the prompt, remembers it
zswarm bus                   # enabled? ready? how many pushes?
zswarm bus --install --force # reload a rebuilt wasm under a fresh key
```

By hand:

```bash
zellij action launch-or-focus-plugin --configuration instance=zswarm-bus \
  file:/abs/path/zswarm-bus-v3.wasm
zellij pipe --plugin file:/abs/path/zswarm-bus-v3.wasm \
  --plugin-configuration instance=zswarm-bus --name zswarm -- status
```

The pane renders `zswarm events — <n> panes, <n> pushes`. The push counter is
the point: it climbs on its own as panes open, close, and exit. Nothing polls.

Pipe payloads. A payload opening with `{` is a structured request; anything
else stays a bare word, so the original pipes keep working.

| payload | answer |
|---|---|
| `status` | pane + tab snapshot, from pushed state |
| `events` | push counters only |
| `{"op":"scrollback","panes":["terminal_4"],"full":false}` | pane screens, read on demand |
| `{"op":"changed","panes":["terminal_4"]}` | screens plus "moved since you last asked" |
| `{"op":"wait","pane":"terminal_4","for":"match","match":"DONE"}` | held open, answers when it resolves |

`scrollback` reports unresolvable ids in `missing` instead of failing the batch —
a pane closing between the ask and the read is normal.

`wait` is the only op that does not answer immediately. It calls
`block_cli_pipe_input`, records the request, and polls from `Event::Timer` until
the condition is met, the pane goes idle, or the timeout expires — so one
`zellij pipe` process covers a wait of any length. `regex` is refused outright:
there is no regex engine in the wasm, and a wrong answer is worse than a
fallback. `changed` is the only op that mutates plugin state, remembering the
screen it handed out so the next call can answer without a sample gap.

## Findings

Build traps — all three fail with the same unhelpful
`could not find exported function`:

1. `strip = true` or `lto = true` in `[profile.release]` removes the exports
   Zellij looks for. Leave them off.
2. The crate must be a **binary**, not a `cdylib`. Zellij loads plugins as WASI
   command modules and needs `_start`; a cdylib exports `load`/`update`/`render`
   but no `_start`. `register_plugin!` supplies `main` itself, so `src/main.rs`
   must not define one.
3. A bin target emits `zswarm-events.wasm` (hyphen); a cdylib would emit
   `zswarm_events.wasm` (underscore). Point Zellij at the right file.

Permissions:

- Three separate grants, and missing any one fails differently:
  `ReadApplicationState` for the pane/tab events, `ReadCliPipes` for
  `cli_pipe_output` / `unblock_cli_pipe_input` (without it the plugin holds
  correct state but cannot answer a pipe), and `ReadPaneContents` for
  `get_pane_scrollback`.
- The decision is cached per plugin **URL**. Adding a permission to an
  already-approved plugin does not re-prompt; it is silently denied. Copy the
  wasm to a new filename to force a fresh prompt.
- A plugin launched by `zellij pipe --plugin` has no visible pane, so its
  permission prompt cannot be answered. Load it in a pane first — that is what
  `zswarm bus --install` does.

Answering a pipe:

- The first argument to `cli_pipe_output` is the CLI pipe **id** from
  `PipeSource::Cli(id)`, not the `--name` value.
- Instances of the same plugin under the same configuration collide, and a dead
  one silently swallows the message. Every pipe passes
  `--plugin-configuration instance=<key>`, and zswarm rotates the key when a
  reply comes back empty.
- When the caller's stdin is not a terminal, the CLI reads it and sends a
  **second, empty message at EOF**. Answering it duplicates the JSON; ignoring
  it leaves the caller blocked forever. Unblock it and emit nothing.
- `zellij pipe` answers in milliseconds but does not exit when it has no
  terminal. zswarm reads stdout until the JSON line arrives and then stops
  waiting, rather than waiting for a process that never leaves.
- `Action CliPipe did not complete within 1s timeout` is printed on **successful**
  runs. It is noise, not the error.

## Scope

Two mechanisms, not one. Pane state is **pushed** — the manifest carries id,
title, tab, focus, and exited, so reading it is free. Screen text is **pulled**
via `get_pane_scrollback`, which is the same work `dump-screen` does, relocated
inside the server.

Measured here: the pipe costs ~0.055s fixed plus ~0.0143s per pane, against
~0.050s per pane for `dump-screen`. That is a loss for one pane and a win from
two upward, so only `status` sampling batches through the plugin. `dump`, `tail`,
and `wait` read one pane and keep polling.

Never available from either path: pane command, cwd, floating. Those fall back
to `list-panes`.

`PaneContents.viewport` pads lines to the terminal width where `dump-screen`
leaves them ragged. `normalizeScreen` erases exactly that difference — verified
identical across live panes — so every consumer must normalize before comparing.
