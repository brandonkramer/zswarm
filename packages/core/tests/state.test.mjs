process.env.ZSWARM_LOG = "0";

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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
  /** @type {import('node:child_process').ChildProcess[]} */
  const children = [];
  t.after(async () => {
    // Await / reap every launched child before deleting the worker/state dir.
    // Rejecting early must not leave survivors reading a removed module path.
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill();
        } catch {
          // already exiting
        }
      }
    }
    await Promise.all(
      children.map(
        (child) =>
          new Promise((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) {
              resolve();
              return;
            }
            child.once("exit", () => resolve());
            child.once("error", () => resolve());
          }),
      ),
    );
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const worker = join(dir, "worker.mjs");
  writeFileSync(
    worker,
    `import { createStateStore } from ${JSON.stringify(pathToFileURL(DIST).href)};
const store = createStateStore({ dir: process.argv[2], env: { ZSWARM_LOG: "0" } });
store.writeCursor(process.argv[3], process.argv[3]);
`,
  );
  const workers = 80;
  // Launch all 80 in one simultaneous wave; await every exit before asserting.
  const results = await Promise.all(
    Array.from({ length: workers }, (_, i) => {
      const child = spawn(process.execPath, [worker, dir, `k${i}`], {
        stdio: "inherit",
      });
      children.push(child);
      return new Promise((resolve) => {
        child.on("exit", (code, signal) => resolve({ i, code, signal }));
        child.on("error", (err) => resolve({ i, code: null, signal: null, err }));
      });
    }),
  );
  for (const result of results) {
    assert.equal(
      result.code,
      0,
      `worker k${result.i} exit ${result.code}${result.signal ? ` signal=${result.signal}` : ""}${result.err ? ` err=${result.err}` : ""}`,
    );
  }
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

/**
 * Normal handoff race: contender B observes holder A's stamp, then A releases
 * and exits before B's liveness check. Classification must not refuse a lock
 * that is now absent or held by a live successor C — retry within the wait
 * budget. Hooks only schedule real release / liveness boundaries.
 */
function handoffWriterSource(lockFile, writeCall) {
  return `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { createStateStore } from ${JSON.stringify(pathToFileURL(DIST).href)};
const [dir, key, mode, observedPid] = process.argv.slice(2);
const lock = join(dir, ${JSON.stringify(lockFile)});
function emit(event, fields = {}) {
  fs.writeSync(1, JSON.stringify({ event, ...fields }) + "\\n");
}
function resume() {
  const b = Buffer.alloc(1);
  if (fs.readSync(0, b, 0, 1, null) !== 1) throw new Error("missing release byte");
}
if (mode === "holder") {
  const originalRm = fs.rmSync;
  let once = false;
  fs.rmSync = function (path, ...args) {
    if (!once && String(path) === lock) {
      once = true;
      emit("holding", { pid: process.pid });
      resume();
    }
    return originalRm.call(this, path, ...args);
  };
  syncBuiltinESMExports();
} else {
  const originalKill = process.kill;
  let once = false;
  process.kill = function (pid, signal) {
    if (!once && pid === Number(observedPid) && signal === 0) {
      once = true;
      emit("observed", { pid });
      resume();
    }
    return originalKill.call(this, pid, signal);
  };
}
try {
  const store = createStateStore({ dir, env: { ZSWARM_LOG: "0" } });
  ${writeCall}
  emit("done", { key });
} catch (err) {
  emit("error", { key, message: err instanceof Error ? err.message : String(err) });
  process.exitCode = 2;
}
`;
}

function launchHandoffWriter(file, dir, key, mode, observedPid = "") {
  const child = spawn(process.execPath, [file, dir, key, mode, String(observedPid)], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const rows = [];
  const pending = [];
  let buffer = "";
  let stderr = "";
  child.stdin.on("error", () => {});
  child.stderr.on("data", (b) => {
    stderr += b;
  });
  child.stdout.on("data", (b) => {
    buffer += b;
    let split;
    while ((split = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, split);
      buffer = buffer.slice(split + 1);
      if (!line) continue;
      const row = JSON.parse(line);
      rows.push(row);
      for (let i = pending.length - 1; i >= 0; i--) {
        if (pending[i].event === row.event) {
          pending[i].resolve(row);
          pending.splice(i, 1);
        }
      }
    }
  });
  const closed = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => {
      for (const p of pending.splice(0)) {
        p.reject(new Error(`child closed before ${p.event}: ${stderr}`));
      }
      resolve({ code, signal, rows, stderr });
    });
  });
  return {
    child,
    closed,
    rows,
    release: () => child.stdin.end("x"),
    event: (event) => {
      const row = rows.find((r) => r.event === event);
      return row
        ? Promise.resolve(row)
        : new Promise((resolve, reject) => pending.push({ event, resolve, reject }));
    },
  };
}

for (const { name, lockFile, writeCall, readKeys } of [
  {
    name: "writeCursor",
    lockFile: "cursors.lock",
    writeCall: "store.writeCursor(key, key);",
    readKeys: (dir, keys) => {
      const values = JSON.parse(readFileSync(join(dir, "cursors.json"), "utf8"));
      for (const key of keys) assert.equal(values[key], key, `${key} missing`);
    },
  },
  {
    name: "postSignal",
    lockFile: "signals.lock",
    writeCall: "store.postSignal(key, key, Date.now());",
    readKeys: (dir, keys) => {
      const values = JSON.parse(readFileSync(join(dir, "signals.json"), "utf8"));
      for (const key of keys) {
        assert.ok(values[key], `${key} missing`);
        assert.equal(values[key].count >= 1, true);
      }
    },
  },
]) {
  for (const successor of [false, true]) {
    test(
      `${name}: departed observed owner with ${successor ? "live successor" : "absent lock"} permits normal acquisition`,
      { timeout: 10_000 },
      async (t) => {
        const dir = mkdtempSync(join(tmpdir(), "zswarm-lock-handoff-"));
        const file = join(dir, "writer.mjs");
        writeFileSync(file, handoffWriterSource(lockFile, writeCall));
        const children = [];
        let releaseTimer;
        t.after(async () => {
          if (releaseTimer) clearTimeout(releaseTimer);
          for (const c of children) {
            if (c.child.exitCode === null && c.child.signalCode === null) {
              c.child.kill();
            }
          }
          await Promise.allSettled(children.map((c) => c.closed));
          rmSync(dir, { recursive: true, force: true });
        });
        const a = launchHandoffWriter(file, dir, "A", "holder");
        children.push(a);
        const owner = await a.event("holding");
        const b = launchHandoffWriter(file, dir, "B", "contender", owner.pid);
        children.push(b);
        await b.event("observed");
        a.release();
        assert.equal((await a.closed).code, 0);
        assert.equal(existsSync(join(dir, lockFile)), false);
        let c;
        if (successor) {
          c = launchHandoffWriter(file, dir, "C", "holder");
          children.push(c);
          await c.event("holding");
        }
        b.release();
        if (c) releaseTimer = setTimeout(() => c.release(), 100);
        const result = await b.closed;
        if (c) assert.equal((await c.closed).code, 0);
        assert.equal(
          result.code,
          0,
          `normal handoff must not need operator recovery: ${JSON.stringify(result.rows)} ${result.stderr}`,
        );
        readKeys(dir, successor ? ["A", "B", "C"] : ["A", "B"]);
      },
    );
  }
}

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
