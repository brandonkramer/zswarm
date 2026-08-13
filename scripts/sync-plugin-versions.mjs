#!/usr/bin/env node
/**
 * Keep harness plugin manifests on the same version as the published
 * `zswarm` meta-package. Changesets bump workspace package.json files;
 * Claude / Codex / Cursor read `.*-plugin/plugin.json` and will not
 * pick up a release unless that version moves too.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const PLUGIN_MANIFESTS = [
  ".claude-plugin/plugin.json",
  ".codex-plugin/plugin.json",
  ".cursor-plugin/plugin.json",
];

export const PRODUCT_MANIFEST = join("packages", "zswarm", "package.json");

export function readProductVersion(root = ROOT) {
  const path = join(root, PRODUCT_MANIFEST);
  const pkg = JSON.parse(readFileSync(path, "utf8"));
  if (typeof pkg.version !== "string" || !pkg.version.trim()) {
    throw new Error(`${PRODUCT_MANIFEST} has no version`);
  }
  return pkg.version.trim();
}

export function syncPluginVersions(root = ROOT, version = readProductVersion(root)) {
  const changed = [];
  for (const rel of PLUGIN_MANIFESTS) {
    const path = join(root, rel);
    const json = JSON.parse(readFileSync(path, "utf8"));
    if (json.version === version) continue;
    json.version = version;
    writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`);
    changed.push(rel);
  }
  return { version, changed };
}

function invokedAsCli() {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  return resolve(fileURLToPath(import.meta.url)) === resolve(argv1);
}

if (invokedAsCli()) {
  const { version, changed } = syncPluginVersions();
  if (changed.length === 0) {
    console.log(`plugin versions already ${version}`);
  } else {
    console.log(`plugin versions -> ${version} (${changed.join(", ")})`);
  }
}
