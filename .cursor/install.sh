#!/usr/bin/env bash
# Cloud Agent bootstrap for zSwarm.
#
# Idempotent: safe to run repeatedly and against a cached/partially prepared
# checkout. It only refreshes toolchains, dependencies, and build output derived
# from the checked-out source. No long-running process is started here.
set -euo pipefail

ZELLIJ_VERSION="v0.45.1"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

# --- Rust toolchain -----------------------------------------------------------
# The event-bus WASM plugin (crates/zswarm-events) pulls transitive crates that
# require the edition2024 Cargo feature, which needs Cargo >= 1.85. The base
# image pins an older default toolchain, so select stable and add the wasm
# target the plugin builds against (pnpm build:plugin -> wasm32-wasip1).
if command -v rustup >/dev/null 2>&1; then
  rustup default stable
  rustup target add wasm32-wasip1
fi

# --- Zellij runtime -----------------------------------------------------------
# zSwarm coordinates CLI agents across Zellij panes, so the CLI/MCP server need
# a real `zellij` on PATH. Pin the version the maintainers smoke-test against.
zellij_wanted="zellij ${ZELLIJ_VERSION#v}"
if ! command -v zellij >/dev/null 2>&1 || [ "$(zellij --version 2>/dev/null)" != "$zellij_wanted" ]; then
  tmp="$(mktemp -d)"
  curl -fsSL -o "$tmp/zellij.tgz" \
    "https://github.com/zellij-org/zellij/releases/download/${ZELLIJ_VERSION}/zellij-x86_64-unknown-linux-musl.tar.gz"
  tar -xzf "$tmp/zellij.tgz" -C "$tmp"
  sudo install -m 0755 "$tmp/zellij" /usr/local/bin/zellij
  rm -rf "$tmp"
fi

# Pre-seed a default config so a fresh session skips Zellij's interactive
# first-run wizard (which would otherwise block a non-interactive terminal).
mkdir -p "$HOME/.config/zellij"
if [ ! -f "$HOME/.config/zellij/config.kdl" ]; then
  zellij setup --dump-config > "$HOME/.config/zellij/config.kdl"
fi

# --- JavaScript workspace -----------------------------------------------------
pnpm install --frozen-lockfile

# Build the TypeScript packages so the `zswarm` CLI and `zswarm-mcp` server bins
# exist (dist/ is gitignored). The committed WASM plugin is left as-is; rebuild
# it with `pnpm build:plugin` only when changing crates/zswarm-events.
pnpm -r build
