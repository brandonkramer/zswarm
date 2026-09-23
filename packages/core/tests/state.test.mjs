process.env.ZSWARM_LOG = "0";

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
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

test("postSignal refuses a leftover signals.lock from a dead owner", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zswarm-sig-orphan-"));
  const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
  const pid = child.pid;
  assert.ok(pid);
  await new Promise((resolve, reject) => {
    child.on("exit", resolve);
    child.on("error", reject);
  });
  const lock = join(dir, "signals.lock");
  writeFileSync(lock, JSON.stringify({ pid, at: Date.now() }));
  const store = createStateStore({ dir, env: { ZSWARM_LOG: "0" } });
  assert.throws(
    () => store.postSignal("ch", "x", Date.now()),
    /refusing automatic reclaim|dead-or-abandoned|remove .*signals\.lock/i,
  );
  assert.equal(JSON.parse(readFileSync(lock, "utf8")).pid, pid);
  assert.equal(store.readSignals().ch, undefined);
  rmSync(dir, { recursive: true, force: true });
});

test("postSignal refuses an empty leftover signals.lock older than the pending window", () => {
  const dir = mkdtempSync(join(tmpdir(), "zswarm-sig-empty-"));
  const lock = join(dir, "signals.lock");
  writeFileSync(lock, "");
  const past = new Date(Date.now() - 10_000);
  utimesSync(lock, past, past);
  const store = createStateStore({ dir, env: { ZSWARM_LOG: "0" } });
  assert.throws(
    () => store.postSignal("ch", "x", Date.now()),
    /refusing automatic reclaim|empty or malformed|remove .*signals\.lock/i,
  );
  assert.equal(store.readSignals().ch, undefined);
  rmSync(dir, { recursive: true, force: true });
});

test("postSignal steals a leftover lock owned by this process", () => {
  const dir = mkdtempSync(join(tmpdir(), "zswarm-sig-self-"));
  writeFileSync(
    join(dir, "signals.lock"),
    JSON.stringify({ pid: process.pid, at: Date.now() }),
  );
  const store = createStateStore({ dir, env: { ZSWARM_LOG: "0" } });
  const t0 = Date.now();
  store.postSignal("ch", "x", Date.now());
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(store.readSignals().ch.count, 1);
  rmSync(dir, { recursive: true, force: true });
});

test("postSignal refuses a foreign live-pid lock even when its stamp is old", () => {
  const dir = mkdtempSync(join(tmpdir(), "zswarm-sig-recycle-"));
  // pid 1 is almost always alive; automatic reclaim of foreign owners is refused
  // regardless of stamp age (no stale-window steal).
  writeFileSync(
    join(dir, "signals.lock"),
    JSON.stringify({ pid: 1, at: 1 }),
  );
  const store = createStateStore({ dir, env: { ZSWARM_LOG: "0" } });
  assert.throws(
    () => store.postSignal("ch", "x", Date.now()),
    /timed out waiting for signals\.lock|refusing automatic reclaim/i,
  );
  assert.equal(store.readSignals().ch, undefined);
  rmSync(dir, { recursive: true, force: true });
});

test("writeCursor serializes writers across processes", async (t) => {
  // 80 at once is the Windows case: open(wx) returns EPERM while the holder
  // still has cursors.lock, not EEXIST. Fewer workers never hit it on CI.
  // Non-zero child exits fail before the key check, so a missing key is a
  // lost write (lock not exclusive), not a crashed worker.
  const dir = mkdtempSync(join(tmpdir(), "zswarm-cur-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const worker = join(dir, "worker.mjs");
  writeFileSync(
    worker,
    `import { createStateStore } from ${JSON.stringify(pathToFileURL(DIST).href)};
const store = createStateStore({ dir: process.argv[2], env: { ZSWARM_LOG: "0" } });
store.writeCursor(process.argv[3], process.argv[3]);
`,
  );
  const workers = 80;
  await Promise.all(
    Array.from({ length: workers }, (_, i) =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [worker, dir, `k${i}`], {
          stdio: "inherit",
        });
        child.on("exit", (code) =>
          code === 0 ? resolve() : reject(new Error(`worker exit ${code}`)),
        );
      }),
    ),
  );
  const store = createStateStore({ dir, env: { ZSWARM_LOG: "0" } });
  for (let i = 0; i < workers; i++) {
    assert.equal(store.readCursor(`k${i}`), `k${i}`, `k${i} missing after all 80 workers exited 0`);
  }
});

/**
 * Fail-closed foreign reclaim: an abandoned lock is refused without moving the
 * shared pathname. The repair-02 rename-to-tomb interval (observe → rename live
 * holder aside → admit a third writer) is no longer a cooperating-writer step.
 * Contenders never rename/unlink a foreign generation, so a live critical
 * section cannot be exposed as unlocked to admit another writer.
 */
test("abandoned lock reclaim is refused without displacing the shared lock name", () => {
  const dir = fs.mkdtempSync(join(tmpdir(), "zswarm-lock-refuse-"));
  const lock = join(dir, "cursors.lock");
  const departed = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  assert.equal(departed.status, 0);
  assert.ok(departed.pid);
  assert.throws(() => process.kill(departed.pid, 0), { code: "ESRCH" });
  const seed = { pid: departed.pid, at: Date.now() };
  fs.writeFileSync(lock, JSON.stringify(seed));
  fs.writeFileSync(join(dir, "cursors.json"), JSON.stringify({ seed: "seed" }));

  const originalRename = fs.renameSync;
  const originalRm = fs.rmSync;
  let renamedShared = false;
  let removedShared = false;
  try {
    fs.renameSync = function (from, to, ...args) {
      if (String(from) === lock) renamedShared = true;
      return originalRename.call(this, from, to, ...args);
    };
    fs.rmSync = function (path, ...args) {
      if (String(path) === lock) removedShared = true;
      return originalRm.call(this, path, ...args);
    };
    syncBuiltinESMExports();
    assert.throws(
      () => createStateStore({ dir, env: { ZSWARM_LOG: "0" } }).writeCursor("A", "A"),
      /refusing automatic reclaim|dead-or-abandoned|remove .*cursors\.lock/i,
    );
    assert.equal(renamedShared, false, "fail-closed reclaim must not rename the shared lock");
    assert.equal(removedShared, false, "fail-closed reclaim must not unlink the shared lock");
    assert.deepEqual(JSON.parse(readFileSync(lock, "utf8")), seed);
    assert.equal(
      createStateStore({ dir, env: { ZSWARM_LOG: "0" } }).readCursor("A"),
      null,
    );
  } finally {
    fs.renameSync = originalRename;
    fs.rmSync = originalRm;
    syncBuiltinESMExports();
    originalRm(dir, { recursive: true, force: true });
  }
});

test("multiple contenders refuse the same abandoned lock without entering", async () => {
  const dir = fs.mkdtempSync(join(tmpdir(), "zswarm-lock-multirefuse-"));
  const lock = join(dir, "cursors.lock");
  const departed = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  assert.equal(departed.status, 0);
  fs.writeFileSync(lock, JSON.stringify({ pid: departed.pid, at: Date.now() }));
  fs.writeFileSync(join(dir, "cursors.json"), JSON.stringify({}));

  const worker = join(dir, "refuse-worker.mjs");
  writeFileSync(
    worker,
    `import { createStateStore } from ${JSON.stringify(pathToFileURL(DIST).href)};
const store = createStateStore({ dir: process.argv[2], env: { ZSWARM_LOG: "0" } });
try {
  store.writeCursor(process.argv[3], process.argv[3]);
  process.exit(0);
} catch (err) {
  process.stderr.write(String(err && err.message ? err.message : err));
  process.exit(2);
}
`,
  );

  const results = await Promise.all(
    ["A", "B", "C", "D"].map(
      (key) =>
        new Promise((resolve) => {
          const child = spawn(process.execPath, [worker, dir, key], {
            stdio: ["ignore", "ignore", "pipe"],
          });
          let err = "";
          child.stderr.on("data", (chunk) => {
            err += String(chunk);
          });
          child.on("exit", (code) => resolve({ key, code, err }));
        }),
    ),
  );

  for (const result of results) {
    assert.equal(result.code, 2, `${result.key} must refuse, not enter`);
    assert.match(result.err, /refusing automatic reclaim|dead-or-abandoned/i);
  }
  const store = createStateStore({ dir, env: { ZSWARM_LOG: "0" } });
  for (const key of ["A", "B", "C", "D"]) {
    assert.equal(store.readCursor(key), null, `${key} must not have written`);
  }
  assert.equal(JSON.parse(readFileSync(lock, "utf8")).pid, departed.pid);
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Real cooperating writers under normal release (no abandoned reclaim): a
 * holder that finishes must not lose another successful writer's key. Uses
 * the product API only — no rename/reclaim of foreign locks.
 */
test("successful writers keep keys when a live holder releases normally", async () => {
  const dir = fs.mkdtempSync(join(tmpdir(), "zswarm-lock-live-writers-"));
  const worker = join(dir, "live-worker.mjs");
  writeFileSync(
    worker,
    `import { createStateStore } from ${JSON.stringify(pathToFileURL(DIST).href)};
const store = createStateStore({ dir: process.argv[2], env: { ZSWARM_LOG: "0" } });
store.writeCursor(process.argv[3], process.argv[3]);
`,
  );
  const keys = ["A", "B", "C"];
  await Promise.all(
    keys.map(
      (key) =>
        new Promise((resolve, reject) => {
          const child = spawn(process.execPath, [worker, dir, key], {
            stdio: "inherit",
          });
          child.on("exit", (code) =>
            code === 0 ? resolve() : reject(new Error(`worker exit ${code}`)),
          );
        }),
    ),
  );
  const store = createStateStore({ dir, env: { ZSWARM_LOG: "0" } });
  for (const key of keys) {
    assert.equal(store.readCursor(key), key);
  }
  rmSync(dir, { recursive: true, force: true });
});

test("bus markers are per session and inherit a legacy flat file", () => {
  const dir = mkdtempSync(join(tmpdir(), "zswarm-bus-state-"));
  writeFileSync(
    join(dir, "bus.json"),
    JSON.stringify({
      plugin: "/tmp/zswarm-bus.wasm",
      configKey: "zswarm-bus-28",
      installedAt: 9,
    }),
  );
  const store = createStateStore({ dir, env: { ZSWARM_LOG: "0" } });
  assert.equal(store.readBus("dogster").configKey, "zswarm-bus-28");
  assert.equal(store.readBus("trex").configKey, "zswarm-bus-28");

  store.writeBus("dogster", {
    plugin: "/tmp/zswarm-bus.wasm",
    configKey: "zswarm-bus",
    installedAt: 10,
  });
  assert.equal(store.readBus("dogster").configKey, "zswarm-bus");
  assert.equal(store.readBus("trex"), null);

  store.writeBus("trex", {
    plugin: "/tmp/zswarm-bus.wasm",
    configKey: "zswarm-bus",
    installedAt: 11,
  });
  store.clearBus("dogster");
  assert.equal(store.readBus("dogster"), null);
  assert.equal(store.readBus("trex").installedAt, 11);
});

// Same worker, but only after writeCursor has finished: a static import loads
// doctor/serve-bind fixtures before the 80-child wave, and a parallel *.test.mjs
// worker also drops keys on macOS. Standalone:
// node --import ./test-support/clean-env.mjs --test tests/doctor.mjs
// node --import ./test-support/clean-env.mjs --test tests/serve-bind.mjs
test("doctor fixtures after writeCursor completes", async (t) => {
  const { registerDoctorTests } = await import("./doctor.mjs");
  const queue = [];
  registerDoctorTests((name, fn) => {
    queue.push([name, fn]);
  });
  for (const [name, fn] of queue) {
    await t.test(name, fn);
  }
});

test("serve-bind fixtures after writeCursor completes", async (t) => {
  const { registerServeBindTests } = await import("./serve-bind.mjs");
  const queue = [];
  registerServeBindTests((name, fn) => {
    queue.push([name, fn]);
  });
  for (const [name, fn] of queue) {
    await t.test(name, fn);
  }
});
