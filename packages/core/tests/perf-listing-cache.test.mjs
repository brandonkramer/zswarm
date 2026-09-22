process.env.ZSWARM_BUS = "0";
process.env.ZSWARM_LOG = "0";

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nodeFixture } from "../test-support/node-fixture.mjs";
import { resetIpcDiscoveryCache } from "../dist/exec.js";
import {
  ListingCache,
  createZellijClient,
} from "../dist/index.js";

function paneRow(id, extra = {}) {
  return {
    id,
    is_plugin: false,
    title: extra.title ?? `peer-${id}`,
    exited: extra.exited ?? false,
    is_focused: extra.is_focused ?? false,
    is_floating: false,
    tab_id: extra.tab_id ?? 0,
    tab_name: extra.tab_name ?? "T",
    pane_command: extra.command ?? "bash",
    pane_cwd: extra.cwd ?? "/tmp",
    ...extra,
  };
}

function tabRow(id = 0, name = "T") {
  return {
    position: id,
    tab_id: id,
    name,
    active: id === 0,
    selectable_tiled_panes_count: 1,
  };
}

function makeState(extra = {}) {
  return {
    panes: extra.panes ?? [paneRow(1), paneRow(2)],
    sessions: extra.sessions ?? "crew [Created 1h ago]\n",
    tabs: extra.tabs ?? [tabRow(0, "T")],
    calls: [],
    nextId: 3,
    gate: null,
    renameFails: false,
  };
}

function makeExec(state) {
  return async (args, opts = {}) => {
    state.calls.push({
      op: args.includes("list-sessions")
        ? "list-sessions"
        : args.includes("list-panes")
          ? "list-panes"
          : args.includes("list-tabs")
            ? "list-tabs"
            : args.includes("rename-pane")
              ? "rename-pane"
              : args.includes("new-pane")
                ? "new-pane"
                : args.includes("close-pane")
                  ? "close-pane"
                  : args.includes("focus-pane-id")
                    ? "focus"
                    : args.includes("stack-panes")
                      ? "stack"
                      : args.includes("paste")
                        ? "paste"
                        : args.includes("write-chars")
                          ? "write"
                          : "other",
      timeoutMs: opts.timeoutMs,
    });
    if (opts.signal?.aborted) {
      return { code: -1, stdout: "", stderr: "cancelled" };
    }
    if (args.includes("list-panes")) {
      const snap = JSON.stringify(state.panes);
      if (state.gate) await state.gate;
      const wait = Math.min(state.delayMs ?? 0, opts.timeoutMs ?? 0);
      if (wait) await delay(wait);
      if ((opts.timeoutMs ?? 1e9) < (state.minBudget ?? 0)) {
        return { code: -1, stdout: "", stderr: "timed out" };
      }
      return { code: 0, stdout: snap, stderr: "" };
    }
    if (args.includes("list-sessions")) {
      return { code: 0, stdout: state.sessions, stderr: "" };
    }
    if (args.includes("list-tabs")) {
      return { code: 0, stdout: JSON.stringify(state.tabs), stderr: "" };
    }
    if (args.includes("rename-pane")) {
      if (state.renameFails) {
        return { code: 1, stdout: "", stderr: "rename failed" };
      }
      const name = args.at(-1);
      const id = args[args.indexOf("--pane-id") + 1];
      state.panes = state.panes.map((p) =>
        `terminal_${p.id}` === id || String(p.id) === String(id)?.replace("terminal_", "")
          ? { ...p, title: name }
          : p,
      );
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args.includes("new-pane")) {
      const id = state.nextId++;
      const nameIdx = args.indexOf("--name");
      const title = nameIdx >= 0 ? args[nameIdx + 1] : `peer-${id}`;
      state.panes = [...state.panes, paneRow(id, { title })];
      return { code: 0, stdout: `terminal_${id}\n`, stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
}

function makeClient(exec, extra = {}) {
  const clock = extra.clock ?? { now: 1_000 };
  return createZellijClient({
    env: { ZSWARM_CACHE_TTL_MS: "500", ...(extra.env ?? {}) },
    exec,
    cache: extra.cache === undefined ? new ListingCache() : extra.cache,
    now: extra.now ?? (() => clock.now),
    signal: extra.signal,
    zellijPath: extra.zellijPath,
  });
}

function paneCalls(state) {
  return state.calls.filter((c) => c.op === "list-panes").length;
}

describe("perf listing cache", { concurrency: 1 }, () => {
  test("injected exec does not cache unless cache is passed explicitly", async () => {
    const state = makeState();
    const exec = makeExec(state);
    const client = createZellijClient({ env: { ZSWARM_CACHE_TTL_MS: "500" }, exec });
    await client.listPanes("crew");
    await client.listPanes("crew");
    assert.equal(paneCalls(state), 2);
  });

  test("two clients sharing exec/cache/context reuse completed listings", async () => {
    const state = makeState();
    const exec = makeExec(state);
    const cache = new ListingCache();
    const clock = { now: 1_000 };
    const a = makeClient(exec, { cache, clock });
    const b = makeClient(exec, { cache, clock });
    assert.equal(a.contextKey(), b.contextKey());
    const first = await a.listPanes("crew");
    const second = await b.listPanes("crew");
    const sessions = await b.listSessions();
    await a.listSessions();
    const tabs = await a.listTabs("crew");
    await b.listTabs("crew");
    assert.equal(paneCalls(state), 1);
    assert.equal(state.calls.filter((c) => c.op === "list-sessions").length, 1);
    assert.equal(state.calls.filter((c) => c.op === "list-tabs").length, 1);
    assert.equal(first[0].title, "peer-1");
    assert.deepEqual(second.map((p) => p.id), first.map((p) => p.id));
    assert.equal(sessions[0].name, "crew");
    assert.equal(tabs[0].name, "T");
  });

  test("TTL expiration forces a new listing", async () => {
    const state = makeState();
    const exec = makeExec(state);
    const cache = new ListingCache();
    const clock = { now: 1_000 };
    const client = makeClient(exec, { cache, clock });
    await client.listPanes("crew");
    clock.now += 499;
    await client.listPanes("crew");
    assert.equal(paneCalls(state), 1);
    clock.now += 2;
    state.panes = [paneRow(1, { title: "after-ttl" })];
    const next = await client.listPanes("crew");
    assert.equal(paneCalls(state), 2);
    assert.equal(next[0].title, "after-ttl");
  });

  test("caller mutations cannot poison cached values", async () => {
    const state = makeState();
    const exec = makeExec(state);
    const cache = new ListingCache();
    const client = makeClient(exec, { cache });
    const panes = await client.listPanes("crew");
    panes[0].title = "hacked";
    panes.pop();
    const again = await client.listPanes("crew");
    assert.equal(paneCalls(state), 1);
    assert.equal(again.length, 2);
    assert.equal(again[0].title, "peer-1");
  });

  test("session/binary/user context stay isolated", async () => {
    const state = makeState();
    const exec = makeExec(state);
    const cache = new ListingCache();
    const clock = { now: 1_000 };
    const base = { cache, clock, env: { USER: "alice", HOME: "/a" } };
    const a = makeClient(exec, { ...base, zellijPath: "zellij-a" });
    await a.listPanes("crew");
    await makeClient(exec, { ...base, zellijPath: "zellij-b" }).listPanes("crew");
    await makeClient(exec, {
      ...base,
      zellijPath: "zellij-a",
      env: { USER: "bob", HOME: "/a" },
    }).listPanes("crew");
    await a.listPanes("other");
    assert.equal(paneCalls(state), 4);
    assert.notEqual(a.contextKey(), makeClient(exec, {
      ...base,
      zellijPath: "zellij-a",
      env: { USER: "bob", HOME: "/a" },
    }).contextKey());
  });

  test("real client routing isolates hosts, transport and resolved IPC namespaces", async (t) => {
    resetIpcDiscoveryCache(); t.after(resetIpcDiscoveryCache);
    const fixture = nodeFixture(t, `
      const cmd = process.argv.at(-1);
      if (cmd.includes('powershell.exe')) {
        console.log('zellij.exe --server ' + process.env.FIXTURE_IPC + '/zellij/contract_version_1/crew');
      } else {
        console.log(JSON.stringify([{ id: 1, title: process.argv.slice(2).join(' '), exited: false }]));
      }
    `);
    const cache = new ListingCache();
    const base = { ZSWARM_SSH: "host-a", ZSWARM_SSH_BIN: fixture.binary, ZSWARM_REMOTE_BIN: "zellij.exe", ZSWARM_TMP: "C:/ipc-a" };
    const client = (env) => createZellijClient({ env, cache, skipIdentityProbe: true, now: () => 1000 });
    const a = client(base);
    const titleA = (await a.listPanes("crew"))[0].title;
    assert.equal((await client(base).listPanes("crew"))[0].title, titleA);
    assert.equal(fixture.launches.length, 1, "separate real clients reuse the same completed context");
    const otherHost = (await client({ ...base, ZSWARM_SSH: "host-b" }).listPanes("crew"))[0].title;
    assert.match(otherHost, /host-b/);
    const otherIpc = (await client({ ...base, ZSWARM_TMP: "C:/ipc-b" }).listPanes("crew"))[0].title;
    assert.match(otherIpc, /ipc-b/);
    const local = (await client({ ZSWARM_BIN: fixture.binary }).listPanes("crew"))[0].title;
    assert.doesNotMatch(local, /host-a|ipc-a/);
    assert.equal(fixture.launches.length, 4);

    const auto = { ...base, ZSWARM_TMP: "auto", FIXTURE_IPC: "C:/first" };
    const first = (await client(auto).listPanes("crew"))[0].title;
    assert.match(first, /first/);
    const warmed = fixture.launches.length;
    await client(auto).listPanes("crew");
    assert.equal(fixture.launches.length, warmed, "warm resolved auto IPC also reuses listings");
    resetIpcDiscoveryCache(); // An expired IPC hit must not reuse its still-live listing.
    const second = (await client({ ...auto, FIXTURE_IPC: "C:/second" }).listPanes("crew"))[0].title;
    assert.match(second, /second/);
    assert.equal(fixture.launches.length, warmed + 2, "fresh discovery plus a listing in the new socket namespace");
  });

  test("input, pane and tab mutations each invalidate completed metadata", async () => {
    const state = makeState();
    const client = makeClient(makeExec(state));
    const mutations = [
      () => client.closePane({ session: "crew", paneId: "2" }),
      () => client.focusPane({ session: "crew", paneId: "1" }),
      () => client.stackPanes({ session: "crew", paneIds: ["1", "2"] }),
      () => client.newTab({ session: "crew", name: "new" }),
      () => client.renameTab({ session: "crew", tabId: 0, name: "renamed" }),
      () => client.injectPane({ session: "crew", paneId: "1", text: "hello" }),
    ];
    for (const [i, mutate] of mutations.entries()) {
      await client.listPanes("crew");
      await client.listTabs("crew");
      await mutate();
      state.panes = [paneRow(1, { title: `after-${i}` })];
      state.tabs = [tabRow(0, `tab-${i}`)];
      assert.equal((await client.listPanes("crew"))[0].title, `after-${i}`);
      assert.equal((await client.listTabs("crew"))[0].name, `tab-${i}`);
    }
  });

  test("an IPC refresh cannot relabel a pending listing or redirect its following write", async (t) => {
    resetIpcDiscoveryCache(); t.after(resetIpcDiscoveryCache);
    const fixture = nodeFixture(t, `
      import { existsSync, writeFileSync } from 'node:fs';
      const cmd = process.argv.at(-1);
      if (cmd.includes('powershell.exe')) {
        console.log('zellij.exe --server ' + process.env.FIXTURE_IPC + '/zellij/contract_version_1/crew');
      } else if (cmd.includes('list-panes')) {
        if (process.env.HOLD === '1') {
          writeFileSync(process.env.READY, 'ready');
          while (!existsSync(process.env.RELEASE)) await new Promise(r => setTimeout(r, 5));
        }
        console.log(JSON.stringify([{ id: 1, title: cmd, exited: false }]));
      } else console.log('crew');
    `);
    const cache = new ListingCache();
    const env = {
      ZSWARM_SSH: "racing-host", ZSWARM_SSH_BIN: fixture.binary, ZSWARM_REMOTE_BIN: "zellij.exe", ZSWARM_TMP: "auto",
      READY: join(fixture.dir, 'ready'), RELEASE: join(fixture.dir, 'release'), FIXTURE_IPC: 'C:/first', HOLD: '1',
    };
    const client = (extra) => createZellijClient({ env: { ...env, ...extra }, cache, skipIdentityProbe: true, now: () => 1000 });
    const first = client();
    const pending = first.listPanes('crew', 5000);
    try {
      const until = Date.now() + 3000;
      while (!existsSync(env.READY) && Date.now() < until) await delay(5);
      assert.ok(existsSync(env.READY), 'first listing did not start');
      resetIpcDiscoveryCache(); // Expired discovery is refreshed by a sibling.
      const second = client({ FIXTURE_IPC: 'C:/second', HOLD: '0' });
      await second.listSessions();
      writeFileSync(env.RELEASE, 'release');
      assert.match((await pending)[0].title, /first/);
      assert.match(first.transport.ipc.tmp, /first/);
      await first.writeChars({ session: 'crew', paneId: '1', chars: 'echo ok' });
      assert.match(fixture.launches.at(-1).args.at(-1), /first/);
      assert.doesNotMatch(fixture.launches.at(-1).args.at(-1), /second/);
      const current = await second.listPanes('crew');
      assert.match(current[0].title, /second/, 'old response was cached in the new IPC namespace');
    } finally {
      writeFileSync(env.RELEASE, 'release');
      await pending.catch(() => {});
    }
  });

  test("distinct injected execs do not share listings even with the same cache", async () => {
    const stateA = makeState();
    const stateB = makeState({ panes: [paneRow(9, { title: "other-exec" })] });
    const cache = new ListingCache();
    const clock = { now: 1_000 };
    const a = makeClient(makeExec(stateA), { cache, clock });
    const b = makeClient(makeExec(stateB), { cache, clock });
    assert.equal((await a.listPanes("crew"))[0].title, "peer-1");
    assert.equal((await b.listPanes("crew"))[0].title, "other-exec");
    assert.equal(paneCalls(stateA), 1);
    assert.equal(paneCalls(stateB), 1);
  });

  test("mutation methods invalidate, including failed writes", async () => {
    const state = makeState();
    const exec = makeExec(state);
    const cache = new ListingCache();
    const client = makeClient(exec, { cache });
    await client.listPanes("crew");
    await client.renamePane({ session: "crew", paneId: "1", name: "renamed" });
    const afterRename = await client.listPanes("crew");
    assert.equal(afterRename.find((p) => p.id === "terminal_1").title, "renamed");
    assert.ok(paneCalls(state) >= 2);

    await client.listPanes("crew");
    const cached = paneCalls(state);
    state.renameFails = true;
    await assert.rejects(
      () => client.renamePane({ session: "crew", paneId: "1", name: "nope" }),
      /rename failed/,
    );
    await client.listPanes("crew");
    assert.ok(paneCalls(state) > cached, "failed mutation must drop the listing");

    await client.focusPane({ session: "crew", paneId: "1" });
    await client.closePane({ session: "crew", paneId: "2" });
    await client.stackPanes({ session: "crew", paneIds: ["1", "2"] });
    const afterWrites = paneCalls(state);
    await client.listPanes("crew");
    assert.ok(paneCalls(state) > afterWrites);
  });

  test("a read racing a mutation cannot repopulate a stale listing", async () => {
    const state = makeState();
    const exec = makeExec(state);
    const cache = new ListingCache();
    const client = makeClient(exec, { cache });
    let release;
    state.gate = new Promise((resolve) => {
      release = resolve;
    });
    const racing = client.listPanes("crew");
    await delay(20);
    state.panes = [paneRow(1, { title: "mutated" }), paneRow(2)];
    await client.renamePane({ session: "crew", paneId: "1", name: "mutated" });
    release();
    const raced = await racing;
    assert.equal(raced[0].title, "peer-1");
    const next = await client.listPanes("crew");
    assert.equal(next[0].title, "mutated");
    assert.ok(paneCalls(state) >= 2);
  });

  test("bus revision invalidates session listings", async () => {
    const state = makeState();
    const exec = makeExec(state);
    const cache = new ListingCache();
    const client = makeClient(exec, { cache });
    await client.listPanes("crew");
    client.observeManifest("crew", "rev-1");
    state.panes = [paneRow(1, { title: "from-bus" })];
    const afterFirst = await client.listPanes("crew");
    assert.equal(afterFirst[0].title, "from-bus");
    const callsAfterFirst = paneCalls(state);
    client.observeManifest("crew", "rev-1");
    await client.listPanes("crew");
    assert.equal(paneCalls(state), callsAfterFirst, "same revision must not drop");
    client.observeManifest("crew", "rev-2");
    state.panes = [paneRow(1, { title: "rev-2" })];
    assert.equal((await client.listPanes("crew"))[0].title, "rev-2");
    assert.ok(paneCalls(state) > callsAfterFirst);
  });

  test("cancelled or short-budget callers do not inherit another in-flight listing", async () => {
    const state = makeState();
    state.delayMs = 80;
    state.minBudget = 40;
    const exec = makeExec(state);
    const cache = new ListingCache();
    const ac = new AbortController();
    const slow = makeClient(exec, { cache, signal: ac.signal });
    const other = makeClient(exec, { cache });
    const pending = slow.listPanes("crew", 5000);
    await delay(10);
    ac.abort();
    await assert.rejects(pending, /cancel|timed out|failed/i);
    const start = Date.now();
    await assert.rejects(() => other.listPanes("crew", 15));
    assert.ok(Date.now() - start < 60, "short caller waited for the other budget");
    state.delayMs = 0;
    state.minBudget = 0;
    const ok = await other.listPanes("crew", 2000);
    assert.equal(ok[0].id, "terminal_1");
  });

  test("fresh reads see a just-created or renamed pane", async () => {
    const state = makeState();
    const exec = makeExec(state);
    const cache = new ListingCache();
    const client = makeClient(exec, { cache });
    await client.listPanes("crew");
    await client.newPane({ session: "crew", name: "fresh-pane" });
    const created = await client.listPanes("crew");
    assert.ok(created.some((p) => p.title === "fresh-pane"));
    await client.renamePane({ session: "crew", paneId: "1", name: "fresh-name" });
    const renamed = await client.listPanes("crew", undefined, { fresh: true });
    assert.equal(renamed.find((p) => p.id === "terminal_1").title, "fresh-name");
    state.panes = [paneRow(1, { title: "stale-if-cached" })];
    const cached = await client.listPanes("crew");
    assert.equal(cached.find((p) => p.id === "terminal_1").title, "fresh-name");
    const forced = await client.listPanes("crew", undefined, { fresh: true });
    assert.equal(forced[0].title, "stale-if-cached");
  });

  test("invalidateListings drops session and session-list caches", async () => {
    const state = makeState();
    const exec = makeExec(state);
    const cache = new ListingCache();
    const client = makeClient(exec, { cache });
    await client.listPanes("crew");
    await client.listSessions();
    client.invalidateListings("crew");
    state.sessions = "other [Created 1h ago]\n";
    state.panes = [paneRow(4, { title: "after-invalidate" })];
    assert.equal((await client.listPanes("crew"))[0].title, "after-invalidate");
    assert.equal((await client.listSessions())[0].name, "other");
  });
});
