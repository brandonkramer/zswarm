process.env.ZSWARM_LOG = "0";

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createStateStore } from "../dist/index.js";

const DIST = join(dirname(fileURLToPath(import.meta.url)), "../dist/index.js");

test("postSignal serializes writers across processes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zswarm-sig-"));
  const worker = join(dir, "worker.mjs");
  writeFileSync(
    worker,
    `import { createStateStore } from ${JSON.stringify(pathToFileURL(DIST).href)};
const store = createStateStore({ dir: process.argv[2], env: { ZSWARM_LOG: "0" } });
const n = Number(process.argv[3]);
for (let i = 0; i < n; i++) store.postSignal("ch", String(i), Date.now());
`,
  );
  const workers = 8;
  const each = 10;
  await Promise.all(
    Array.from({ length: workers }, () =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [worker, dir, String(each)], {
          stdio: "inherit",
        });
        child.on("exit", (code) =>
          code === 0 ? resolve() : reject(new Error(`worker exit ${code}`)),
        );
      }),
    ),
  );
  const store = createStateStore({ dir, env: { ZSWARM_LOG: "0" } });
  assert.equal(store.readSignals().ch.count, workers * each);
});

test("postSignal steals a leftover signals.lock from a dead owner", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zswarm-sig-orphan-"));
  const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
  const pid = child.pid;
  assert.ok(pid);
  await new Promise((resolve, reject) => {
    child.on("exit", resolve);
    child.on("error", reject);
  });
  writeFileSync(join(dir, "signals.lock"), JSON.stringify({ pid, at: Date.now() }));
  const store = createStateStore({ dir, env: { ZSWARM_LOG: "0" } });
  const t0 = Date.now();
  store.postSignal("ch", "x", Date.now());
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(store.readSignals().ch.count, 1);
});

test("postSignal steals an empty leftover signals.lock older than the wait", () => {
  const dir = mkdtempSync(join(tmpdir(), "zswarm-sig-empty-"));
  const lock = join(dir, "signals.lock");
  writeFileSync(lock, "");
  const past = new Date(Date.now() - 10_000);
  utimesSync(lock, past, past);
  const store = createStateStore({ dir, env: { ZSWARM_LOG: "0" } });
  const t0 = Date.now();
  store.postSignal("ch", "x", Date.now());
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(store.readSignals().ch.count, 1);
});
