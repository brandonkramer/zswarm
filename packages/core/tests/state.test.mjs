process.env.ZSWARM_LOG = "0";

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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
});

test("postSignal steals a live-pid lock older than the stale window", () => {
  const dir = mkdtempSync(join(tmpdir(), "zswarm-sig-recycle-"));
  writeFileSync(
    join(dir, "signals.lock"),
    JSON.stringify({ pid: 1, at: 1 }),
  );
  const store = createStateStore({ dir, env: { ZSWARM_LOG: "0" } });
  const t0 = Date.now();
  store.postSignal("ch", "x", Date.now());
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(store.readSignals().ch.count, 1);
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
 * Deterministic filesystem interleaving under rename-to-tomb reclaim.
 *
 * The repair-01 check-then-`rmSync(well-known path)` interval is no longer a
 * cooperating-writer step: reclaim/release rename the shared name to a private
 * tomb, then delete only a matching tomb generation. A successor published at
 * the well-known path is a different inode; the rename loser gets ENOENT and
 * never removes it.
 *
 * This harness schedules a competing reclaim (rename stale aside + wx live
 * owner) immediately before the contender's rename of the shared path — the
 * analogue of the old "replacement after the final check" race — and asserts
 * the live successor is restored/left intact, not destroyed.
 */
test("a stale owner observation must not delete a replacement live owner lock", async () => {
  const dir = fs.mkdtempSync(join(tmpdir(), "zswarm-lock-interleave-"));
  const lock = join(dir, "cursors.lock");
  const departed = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  assert.equal(departed.status, 0);
  assert.ok(departed.pid);
  assert.throws(() => process.kill(departed.pid, 0), { code: "ESRCH" });
  const live = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
    stdio: ["pipe", "ignore", "ignore"],
  });
  const exited = once(live, "exit");
  const originalRead = fs.readFileSync;
  const originalRm = fs.rmSync;
  const originalRename = fs.renameSync;
  let replaced = false;
  let removedLiveOwner = false;
  try {
    process.kill(live.pid, 0);
    fs.writeFileSync(lock, JSON.stringify({ pid: departed.pid, at: Date.now() }));
    fs.renameSync = function (from, to, ...args) {
      if (
        String(from) === lock &&
        String(to).includes(".tomb.") &&
        !replaced
      ) {
        assert.equal(JSON.parse(originalRead(lock, "utf8")).pid, departed.pid);
        const competitorTomb = `${lock}.competitor-won`;
        originalRename(lock, competitorTomb);
        originalRm(competitorTomb, { force: true });
        fs.writeFileSync(lock, JSON.stringify({ pid: live.pid, at: Date.now() }), {
          flag: "wx",
        });
        replaced = true;
      }
      return originalRename.call(this, from, to, ...args);
    };
    fs.rmSync = function (path, ...args) {
      try {
        if (JSON.parse(originalRead(path, "utf8")).pid === live.pid) {
          process.kill(live.pid, 0);
          removedLiveOwner = true;
        }
      } catch (e) {
        if (e.code !== "ENOENT" && e instanceof SyntaxError === false) {
          // ignore non-JSON tombs / missing paths
        }
      }
      return originalRm.call(this, path, ...args);
    };
    syncBuiltinESMExports();
    let outcome;
    try {
      createStateStore({ dir, env: { ZSWARM_LOG: "0" } }).writeCursor("contender", "value");
    } catch (error) {
      outcome = error;
    }
    assert.equal(replaced, true, "interleaving must execute");
    assert.equal(removedLiveOwner, false, "stale contender unlinked the new live owner lock");
    assert.ok(outcome, "contender must wait/fail while another live owner holds the lock");
    assert.equal(
      JSON.parse(originalRead(lock, "utf8")).pid,
      live.pid,
      "live successor must still own the well-known lock path",
    );
  } finally {
    fs.readFileSync = originalRead;
    fs.rmSync = originalRm;
    fs.renameSync = originalRename;
    syncBuiltinESMExports();
    live.stdin.end();
    await exited;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Two reclaimers racing rename-to-tomb on the same stale generation: only one
 * rename wins; the loser must not destroy the winner's subsequent wx claim.
 */
test("multiple reclaimers serialize on rename-to-tomb without deleting the winner", async () => {
  const dir = fs.mkdtempSync(join(tmpdir(), "zswarm-lock-multireclaim-"));
  const lock = join(dir, "cursors.lock");
  const departed = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  assert.equal(departed.status, 0);
  assert.throws(() => process.kill(departed.pid, 0), { code: "ESRCH" });
  fs.writeFileSync(lock, JSON.stringify({ pid: departed.pid, at: Date.now() }));

  const worker = join(dir, "reclaim-worker.mjs");
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
    ["a", "b", "c", "d"].map(
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

  const succeeded = results.filter((r) => r.code === 0);
  const timedOut = results.filter((r) => r.code !== 0);
  // With a live departed lock cleared by the first winner, every worker should
  // eventually acquire in sequence — all four keys must land. If a reclaimer
  // deleted a live successor, we would lose keys or see crashes.
  assert.equal(succeeded.length + timedOut.length, 4);
  const store = createStateStore({ dir, env: { ZSWARM_LOG: "0" } });
  // Retry briefly: losers poll until LOCK_WAIT; all should finish with keys.
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const keys = ["a", "b", "c", "d"].filter((k) => store.readCursor(k) === k);
    if (keys.length === 4) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  for (const key of ["a", "b", "c", "d"]) {
    assert.equal(store.readCursor(key), key, `${key} missing after multi-reclaim wave`);
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
