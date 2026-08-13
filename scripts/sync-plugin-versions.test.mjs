import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PLUGIN_MANIFESTS,
  PRODUCT_MANIFEST,
  readProductVersion,
  syncPluginVersions,
} from "./sync-plugin-versions.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function fakeRepo(productVersion, pluginVersion) {
  const root = mkdtempSync(join(tmpdir(), "zswarm-plugin-ver-"));
  writeJson(join(root, PRODUCT_MANIFEST), {
    name: "zswarm",
    version: productVersion,
  });
  for (const rel of PLUGIN_MANIFESTS) {
    writeJson(join(root, rel), { name: "zswarm", version: pluginVersion });
  }
  return root;
}

test("PLUGIN_MANIFESTS versions match the published zswarm meta-package", () => {
  const product = readProductVersion(REPO_ROOT);
  for (const rel of PLUGIN_MANIFESTS) {
    const json = JSON.parse(readFileSync(join(REPO_ROOT, rel), "utf8"));
    assert.equal(json.name, "zswarm");
    assert.equal(json.version, product, rel);
  }
});

test("readProductVersion reads packages/zswarm", () => {
  const root = fakeRepo("1.2.3", "0.0.1");
  assert.equal(readProductVersion(root), "1.2.3");
});

test("syncPluginVersions writes the product version into every plugin.json", () => {
  const root = fakeRepo("0.2.0", "0.1.0");
  const result = syncPluginVersions(root);
  assert.deepEqual(result, {
    version: "0.2.0",
    changed: [...PLUGIN_MANIFESTS],
  });
  for (const rel of PLUGIN_MANIFESTS) {
    const json = JSON.parse(readFileSync(join(root, rel), "utf8"));
    assert.equal(json.version, "0.2.0");
  }
});

test("syncPluginVersions is a no-op when versions already match", () => {
  const root = fakeRepo("0.2.0", "0.2.0");
  assert.deepEqual(syncPluginVersions(root), { version: "0.2.0", changed: [] });
});

test("readProductVersion fails when the meta-package has no version", () => {
  const root = fakeRepo("0.1.0", "0.1.0");
  writeJson(join(root, PRODUCT_MANIFEST), { name: "zswarm" });
  assert.throws(() => readProductVersion(root), /no version/);
});
