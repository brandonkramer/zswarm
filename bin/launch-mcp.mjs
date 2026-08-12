#!/usr/bin/env node
/**
 * Cross-host MCP launcher for zSwarm (Cursor / Codex / Claude).
 * Windows-safe: hosts must exec `node` + this file.
 */
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const home = process.env.USERPROFILE || process.env.HOME || homedir();
const thisFile = fileURLToPath(import.meta.url);
const pluginRoot = join(dirname(thisFile), "..");

function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function enrichPath(env) {
  const sep = process.platform === "win32" ? ";" : ":";
  const extras = [
    process.platform === "win32"
      ? join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "Zellij")
      : "",
    join(home, ".local", "bin"),
    join(home, ".cargo", "bin"),
  ].filter(Boolean);
  const current = env.PATH || env.Path || "";
  const merged = [...extras, ...current.split(sep).filter(Boolean)];
  const seen = new Set();
  const path = merged
    .filter((p) => {
      const key = p.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join(sep);
  return { ...env, PATH: path, Path: path };
}

const script = join(pluginRoot, "packages", "mcp", "dist", "mcp-server.js");
if (!isFile(script)) {
  console.error(
    "zswarm: missing packages/mcp/dist/mcp-server.js — run: pnpm install && pnpm run build",
  );
  process.exit(127);
}

const env = enrichPath(process.env);

function expandHome(p) {
  if (typeof p !== "string") return p;
  const t = p.trim();
  if (!t.startsWith("~/") && !t.startsWith("~\\")) return p;
  return join(home, t.slice(2));
}
if (env.ZSWARM_BIN) env.ZSWARM_BIN = expandHome(env.ZSWARM_BIN);
if (env.ZSWARM_PATH) env.ZSWARM_PATH = expandHome(env.ZSWARM_PATH);

const zellijExe = join(
  env.LOCALAPPDATA || join(home, "AppData", "Local"),
  "Zellij",
  "zellij.exe",
);
if (!env.ZSWARM_BIN && !env.ZSWARM_PATH && isFile(zellijExe)) {
  env.ZSWARM_BIN = zellijExe;
}

const child = spawn(process.execPath, [script, ...process.argv.slice(2)], {
  stdio: "inherit",
  env,
  windowsHide: true,
  shell: false,
});
child.on("exit", (code) => process.exit(code ?? 1));
child.on("error", (error) => {
  console.error(error.message);
  process.exit(1);
});
