#!/usr/bin/env node
/**
 * Cross-host MCP launcher for zSwarm (Cursor / Codex / Claude).
 * Windows-safe: hosts must exec `node` + this file.
 *
 * dist/ is gitignored, so a plugin checkout has no mcp-server.js until
 * someone builds. Resolve the workspace build, then a globally installed
 * `@zswarm/mcp`, and name the install/build command if neither exists.
 */
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { createRequire } from "node:module";
import Module from "node:module";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
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

function tryResolve(fromFile, spec) {
  try {
    return createRequire(fromFile).resolve(spec);
  } catch {
    return null;
  }
}

function findMcpServer() {
  const workspace = join(pluginRoot, "packages", "mcp", "dist", "mcp-server.js");
  if (isFile(workspace)) return workspace;

  const fromHere = tryResolve(thisFile, "@zswarm/mcp");
  if (fromHere && isFile(fromHere)) return fromHere;
  const fromCwd = tryResolve(join(process.cwd(), "package.json"), "@zswarm/mcp");
  if (fromCwd && isFile(fromCwd)) return fromCwd;

  const globals = [
    ...(process.env.NODE_PATH ?? "").split(delimiter).filter(Boolean),
    ...Module.globalPaths,
    join(dirname(process.execPath), "..", "lib", "node_modules"),
    process.platform === "win32"
      ? join(
          process.env.APPDATA || join(home, "AppData", "Roaming"),
          "npm",
          "node_modules",
        )
      : join(home, ".local", "lib", "node_modules"),
    join(home, ".npm-global", "lib", "node_modules"),
  ];
  for (const dir of globals) {
    const direct = join(dir, "@zswarm", "mcp", "dist", "mcp-server.js");
    if (isFile(direct)) return direct;
    const hit = tryResolve(join(dir, "package.json"), "@zswarm/mcp");
    if (hit && isFile(hit)) return hit;
  }
  return null;
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

const script = findMcpServer();
if (!script) {
  console.error(
    "zswarm: MCP server not found. Build the workspace with: pnpm install && pnpm run build\n" +
      "Or install the package globally with: pnpm add -g @zswarm/mcp",
  );
  process.exit(1);
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
