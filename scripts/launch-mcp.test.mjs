import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findMcpServer, pnpmGlobalNodeModules } from "../bin/launch-mcp.mjs";

function fakeServer(root, rel) {
  const file = join(root, rel);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, "// mcp\n");
  return file;
}

test("findMcpServer prefers the plugin workspace build", () => {
  const root = mkdtempSync(join(tmpdir(), "zswarm-mcp-ws-"));
  const expected = fakeServer(root, join("packages", "mcp", "dist", "mcp-server.js"));
  const pnpmHome = mkdtempSync(join(tmpdir(), "zswarm-mcp-pnpm-"));
  fakeServer(
    pnpmHome,
    join("global", "5", "node_modules", "@zswarm", "mcp", "dist", "mcp-server.js"),
  );
  assert.equal(
    findMcpServer({
      pluginRoot: root,
      thisFile: join(root, "bin", "launch-mcp.mjs"),
      env: { PNPM_HOME: pnpmHome },
      home: root,
      globalPaths: [],
      includeExecPrefix: false,
    }),
    expected,
  );
});

test("findMcpServer searches pnpm's global store", () => {
  const root = mkdtempSync(join(tmpdir(), "zswarm-mcp-empty-"));
  const pnpmHome = mkdtempSync(join(tmpdir(), "zswarm-mcp-global-"));
  const expected = fakeServer(
    pnpmHome,
    join("global", "5", "node_modules", "@zswarm", "mcp", "dist", "mcp-server.js"),
  );
  assert.equal(
    findMcpServer({
      pluginRoot: root,
      thisFile: join(root, "bin", "launch-mcp.mjs"),
      env: { PNPM_HOME: pnpmHome, NODE_PATH: "" },
      home: root,
      globalPaths: [],
      includeExecPrefix: false,
    }),
    expected,
  );
});

test("findMcpServer ignores a forged package in cwd", () => {
  const root = mkdtempSync(join(tmpdir(), "zswarm-mcp-cwd-"));
  const cwd = mkdtempSync(join(tmpdir(), "zswarm-mcp-host-"));
  fakeServer(
    cwd,
    join("node_modules", "@zswarm", "mcp", "dist", "mcp-server.js"),
  );
  const prev = process.cwd();
  process.chdir(cwd);
  try {
    assert.equal(
      findMcpServer({
        pluginRoot: root,
        thisFile: join(root, "bin", "launch-mcp.mjs"),
        env: { PNPM_HOME: join(root, "no-pnpm"), NODE_PATH: "" },
        home: root,
        globalPaths: [],
        includeExecPrefix: false,
      }),
      null,
    );
  } finally {
    process.chdir(prev);
  }
});

test("pnpmGlobalNodeModules lists each global linker version", () => {
  const pnpmHome = mkdtempSync(join(tmpdir(), "zswarm-mcp-linkers-"));
  mkdirSync(join(pnpmHome, "global", "5", "node_modules"), { recursive: true });
  mkdirSync(join(pnpmHome, "global", "6", "node_modules"), { recursive: true });
  const roots = pnpmGlobalNodeModules({ PNPM_HOME: pnpmHome }, pnpmHome);
  assert.equal(roots.length, 2);
  assert.ok(roots.some((p) => p.endsWith(join("5", "node_modules"))));
  assert.ok(roots.some((p) => p.endsWith(join("6", "node_modules"))));
});
