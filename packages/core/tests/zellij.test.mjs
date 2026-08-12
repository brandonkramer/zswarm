import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createZellijClient,
  resolveZellijBinary,
  sanitizeZellijEnv,
  dispatchZswarm,
} from "../dist/index.js";

test("sanitizeZellijEnv drops non-strings", () => {
  const cleaned = sanitizeZellijEnv({
    PATH: "C:\\Windows\\System32",
    FOO: undefined,
    BAR: 1,
    OK: "yes",
  });
  assert.equal(cleaned.OK, "yes");
  assert.equal(cleaned.FOO, undefined);
});

test("resolveZellijBinary prefers ZSWARM_BIN and ZSWARM_PATH", () => {
  const fake = join(tmpdir(), `fake-zellij-${Date.now()}.exe`);
  writeFileSync(fake, "");
  try {
    assert.equal(resolveZellijBinary({ ZSWARM_BIN: fake, PATH: "" }), fake);
    assert.equal(resolveZellijBinary({ ZSWARM_PATH: fake, PATH: "" }), fake);
    assert.equal(
      resolveZellijBinary({
        ZSWARM_PATH: `"${fake}"`,
        PATH: "",
      }),
      fake,
    );
  } finally {
    unlinkSync(fake);
  }
});

test("resolveZellijBinary expands ~/ in ZSWARM_BIN", () => {
  const home = join(tmpdir(), `zswarm-home-${Date.now()}`);
  const abs = join(home, "bin", "zellij-fake");
  mkdirSync(join(home, "bin"), { recursive: true });
  writeFileSync(abs, "");
  try {
    assert.equal(
      resolveZellijBinary({
        ZSWARM_BIN: "~/bin/zellij-fake",
        HOME: home,
        USERPROFILE: home,
        PATH: "",
      }),
      abs,
    );
  } finally {
    unlinkSync(abs);
  }
});

test("formatPeerMessage and argv builders", () => {
  const client = createZellijClient({
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  });
  assert.equal(
    client.formatPeerMessage("alice", "hi"),
    "[zswarm from=alice]\nhi",
  );
  assert.equal(client.normalizePaneId("3"), "terminal_3");
  assert.deepEqual(client.buildListPanesArgs("sess"), [
    "--session",
    "sess",
    "action",
    "list-panes",
    "--json",
    "--command",
    "--state",
    "--tab",
  ]);
  assert.deepEqual(client.buildPasteArgs("sess", "3", "hello"), [
    "--session",
    "sess",
    "action",
    "paste",
    "--pane-id",
    "terminal_3",
    "hello",
  ]);
  assert.deepEqual(client.buildSendEnterArgs("sess", "terminal_0"), [
    "--session",
    "sess",
    "action",
    "send-keys",
    "--pane-id",
    "terminal_0",
    "Enter",
  ]);
  assert.deepEqual(client.buildDumpArgs("sess", "2", true), [
    "--session",
    "sess",
    "action",
    "dump-screen",
    "--pane-id",
    "terminal_2",
    "--full",
  ]);
});

test("bare numeric prefers terminal over plugin", () => {
  const client = createZellijClient({
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  });
  const panes = [
    {
      id: "plugin_0",
      numericId: 0,
      isPlugin: true,
      title: "hub",
      focused: false,
      exited: false,
      floating: false,
    },
    {
      id: "terminal_0",
      numericId: 0,
      isPlugin: false,
      title: "cli",
      command: "codex.exe",
      focused: true,
      exited: false,
      floating: false,
    },
  ];
  assert.equal(client.resolvePane(panes, "0").id, "terminal_0");
});

test("dispatch list sorts panes and send uses paste+Enter", async () => {
  const panesJson = JSON.stringify([
    {
      id: 2,
      is_plugin: false,
      is_focused: false,
      title: "b",
      exited: false,
      is_floating: false,
      tab_name: "T",
      pane_command: "codex.exe",
    },
    {
      id: 1,
      is_plugin: false,
      is_focused: true,
      title: "a",
      exited: false,
      is_floating: false,
      tab_name: "T",
      pane_command: "claude.exe",
    },
    {
      id: 0,
      is_plugin: true,
      is_focused: false,
      title: "plugin",
      exited: false,
      is_floating: false,
      tab_name: "T",
    },
  ]);
  const calls = [];
  const client = createZellijClient({
    env: {},
    exec: async (args) => {
      calls.push(args);
      if (args.includes("list-sessions")) {
        return { code: 0, stdout: "demo\n", stderr: "" };
      }
      if (args.includes("list-panes")) {
        return { code: 0, stdout: panesJson, stderr: "" };
      }
      return { code: 0, stdout: "screen", stderr: "" };
    },
  });

  const listed = await dispatchZswarm({ op: "list" }, client);
  assert.equal(listed.ok, true);
  assert.deepEqual(
    listed.data.panes.map((p) => p.id),
    ["terminal_1", "terminal_2"],
  );

  const sent = await dispatchZswarm(
    { op: "send", to: "1", body: "ping", from: "alice" },
    client,
  );
  assert.equal(sent.ok, true);
  assert.equal(sent.data.delivery, "zellij_paste");
  assert.ok(calls.some((a) => a.includes("paste")));
  assert.ok(calls.some((a) => a.includes("Enter")));
  const paste = calls.find((a) => a.includes("paste"));
  assert.ok(paste.some((x) => String(x).includes("[zswarm from=alice]")));
});

test("resolveZellijBinary finds LocalAppData on Windows when present", () => {
  if (process.platform !== "win32") return;
  const local = join(
    process.env.LOCALAPPDATA || "",
    "Zellij",
    "zellij.exe",
  );
  if (!existsSync(local)) return;
  assert.equal(
    resolveZellijBinary({
      PATH: "C:\\does\\not\\exist",
      LOCALAPPDATA: process.env.LOCALAPPDATA,
      USERPROFILE: process.env.USERPROFILE,
    }),
    local,
  );
});
