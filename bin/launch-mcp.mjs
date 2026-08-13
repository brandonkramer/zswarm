#!/usr/bin/env node
/**
 * Cross-host MCP launcher for zSwarm (Cursor / Codex / Claude).
 * Windows-safe: hosts must exec `node` + this file.
 *
 * dist/ is gitignored, so a plugin checkout has no mcp-server.js until
 * someone builds. Resolve the workspace build, then a globally installed
 * `@zswarm/mcp` from trusted roots — never from the host's current project,
 * which can plant a forged package next to an unrelated repo.
 */
import { spawn } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import Module from "node:module";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

/** pnpm's global node_modules roots (`pnpm root -g` and siblings). */
export function pnpmGlobalNodeModules(
  env = process.env,
  home = env.USERPROFILE || env.HOME || homedir(),
) {
  const pnpmHome =
    env.PNPM_HOME?.trim() ||
    (process.platform === "win32"
      ? join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "pnpm")
      : process.platform === "darwin"
        ? join(home, "Library", "pnpm")
        : join(home, ".local", "share", "pnpm"));
  const globalRoot = join(pnpmHome, "global");
  try {
    return readdirSync(globalRoot, { withFileTypes: true })
      .filter((ent) => ent.isDirectory())
      .map((ent) => join(globalRoot, ent.name, "node_modules"));
  } catch {
    return [];
  }
}

export function findMcpServer(options = {}) {
  const thisFile = options.thisFile ?? fileURLToPath(import.meta.url);
  const pluginRoot = options.pluginRoot ?? join(dirname(thisFile), "..");
  const env = options.env ?? process.env;
  const home = options.home ?? (env.USERPROFILE || env.HOME || homedir());

  const workspace = join(pluginRoot, "packages", "mcp", "dist", "mcp-server.js");
  if (isFile(workspace)) return workspace;

  const fromHere = tryResolve(thisFile, "@zswarm/mcp");
  if (fromHere && isFile(fromHere)) return fromHere;

  const globals = [
    ...(env.NODE_PATH ?? "").split(delimiter).filter(Boolean),
    ...(options.globalPaths ?? Module.globalPaths),
    ...(options.includeExecPrefix === false
      ? []
      : [join(dirname(process.execPath), "..", "lib", "node_modules")]),
    process.platform === "win32"
      ? join(
          env.APPDATA || join(home, "AppData", "Roaming"),
          "npm",
          "node_modules",
        )
      : join(home, ".local", "lib", "node_modules"),
    join(home, ".npm-global", "lib", "node_modules"),
    ...pnpmGlobalNodeModules(env, home),
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
  const home = env.USERPROFILE || env.HOME || homedir();
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

function expandHome(p, home) {
  if (typeof p !== "string") return p;
  const t = p.trim();
  if (!t.startsWith("~/") && !t.startsWith("~\\")) return p;
  return join(home, t.slice(2));
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return resolve(fileURLToPath(import.meta.url)) === resolve(entry);
  } catch {
    return false;
  }
}

export function main(env = process.env) {
  const script = findMcpServer({ env });
  if (!script) {
    console.error(
      "zswarm: MCP server not found. Build the workspace with: pnpm install && pnpm run build\n" +
        "Or install globally with: pnpm add -g zswarm\n" +
        "(pnpm's global store is searched via PNPM_HOME, not only npm's prefix.)",
    );
    process.exit(1);
  }

  const home = env.USERPROFILE || env.HOME || homedir();
  const childEnv = enrichPath(env);
  if (childEnv.ZSWARM_BIN) childEnv.ZSWARM_BIN = expandHome(childEnv.ZSWARM_BIN, home);
  if (childEnv.ZSWARM_PATH) childEnv.ZSWARM_PATH = expandHome(childEnv.ZSWARM_PATH, home);

  const zellijExe = join(
    childEnv.LOCALAPPDATA || join(home, "AppData", "Local"),
    "Zellij",
    "zellij.exe",
  );
  if (!childEnv.ZSWARM_BIN && !childEnv.ZSWARM_PATH && isFile(zellijExe)) {
    childEnv.ZSWARM_BIN = zellijExe;
  }

  const child = spawn(process.execPath, [script, ...process.argv.slice(2)], {
    stdio: "inherit",
    env: childEnv,
    windowsHide: true,
    shell: false,
  });
  child.on("exit", (code) => process.exit(code ?? 1));
  child.on("error", (error) => {
    console.error(error.message);
    process.exit(1);
  });
}

if (isDirectRun()) main();
