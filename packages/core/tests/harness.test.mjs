import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveHarness } from "../dist/harness.js";

const WIN = "C:\\Users\\alice\\AppData\\Roaming\\npm";

// The waiting sets, mirrored from src/harness.ts so a drift there fails here.
const GENERIC = [/\(y\/n\)/i, /\[y\/n\]/i, /press enter to continue/i];
const WAITING = {
  codex: GENERIC,
  cursor: GENERIC,
  opencode: [...GENERIC, /Permission required/i, /Allow once/i],
  gemini: [...GENERIC, /Do you want to proceed\?/i, /Accept this file edit\?/i],
  pi: GENERIC,
};

function expectProfile(pane, name, submit) {
  const got = resolveHarness(pane);
  assert.equal(got.name, name);
  assert.equal(got.submit, submit);
  assert.ok(
    Array.isArray(got.waiting) && got.waiting.length > 0,
    `${name} carries a waiting set`,
  );
  assert.deepEqual(got.waiting, WAITING[name], `${name} waiting set`);
}

test("codex resolves from a command path and defaults to double-enter", () => {
  expectProfile({ command: `${WIN}\\codex.cmd`, title: "codex" }, "codex", "double-enter");
});

test("codex resolves from the title when the command is just a shell", () => {
  expectProfile({ command: "bash", title: "agent-codex" }, "codex", "double-enter");
});

test("cursor resolves from a command path and defaults to auto", () => {
  expectProfile({ command: `${WIN}\\cursor-agent.exe`, title: "cursor" }, "cursor", "auto");
});

test("cursor resolves from the title when the command is generic", () => {
  expectProfile({ command: "bash", title: "agent-cursor" }, "cursor", "auto");
});

test("opencode resolves from a command path and defaults to auto", () => {
  expectProfile({ command: `${WIN}\\opencode.exe`, title: "opencode" }, "opencode", "auto");
});

test("opencode resolves from the title when the command is generic", () => {
  expectProfile({ command: "bash", title: "agent-opencode" }, "opencode", "auto");
});

test("gemini resolves from the agy command and defaults to auto", () => {
  expectProfile({ command: `${WIN}\\agy.exe`, title: "gemini" }, "gemini", "auto");
});

test("gemini resolves from a gemini command and from its title", () => {
  expectProfile({ command: "gemini", title: "g" }, "gemini", "auto");
  expectProfile({ command: "bash", title: "agent-gemini" }, "gemini", "auto");
});

test("pi resolves from a scoop shim path and defaults to auto", () => {
  expectProfile(
    {
      command: "C:\\Users\\alice\\scoop\\persist\\nodejs\\bin\\pi.cmd",
      title: "pi",
    },
    "pi",
    "auto",
  );
});

test("pi resolves from a bare command and from its title", () => {
  expectProfile({ command: "pi", title: "term" }, "pi", "auto");
  expectProfile({ command: "bash", title: "agent-pi" }, "pi", "auto");
});

test("pi does not match as a substring of pip, spike, pipe, or pipeline", () => {
  // pip.exe and project dirs all contain "pi" as a bare substring; only a
  // standalone pi (word boundary) may count.
  assert.deepEqual(
    resolveHarness({
      command:
        "C:\\Users\\alice\\AppData\\Local\\Programs\\Python\\Python312\\Scripts\\pip.exe",
      title: "builder",
    }),
    { name: "unknown", submit: "auto", waiting: GENERIC },
  );
  assert.deepEqual(
    resolveHarness({
      command: "C:\\Users\\alice\\projects\\spike\\pipe\\piper\\bin\\bash.exe",
      title: "builder",
    }),
    { name: "unknown", submit: "auto", waiting: GENERIC },
  );
  assert.deepEqual(
    resolveHarness({ command: "bash", title: "pipeline status" }),
    { name: "unknown", submit: "auto", waiting: GENERIC },
  );
  assert.deepEqual(
    resolveHarness({ command: "bash", title: "api-docs" }),
    { name: "unknown", submit: "auto", waiting: GENERIC },
  );
});

test("an unknown pane returns unknown with auto submit", () => {
  assert.deepEqual(resolveHarness({ command: "bash", title: "builder" }), {
    name: "unknown",
    submit: "auto",
    waiting: GENERIC,
  });
});

test("missing or null command and title never throw", () => {
  assert.deepEqual(resolveHarness({}), {
    name: "unknown",
    submit: "auto",
    waiting: GENERIC,
  });
  assert.deepEqual(resolveHarness({ command: null, title: null }), {
    name: "unknown",
    submit: "auto",
    waiting: GENERIC,
  });
  assert.deepEqual(resolveHarness({ command: undefined, title: undefined }), {
    name: "unknown",
    submit: "auto",
    waiting: GENERIC,
  });
  assert.deepEqual(resolveHarness({ command: "", title: "" }), {
    name: "unknown",
    submit: "auto",
    waiting: GENERIC,
  });
});

test("matching is case-insensitive on command and title", () => {
  expectProfile({ command: "CodeX", title: "c" }, "codex", "double-enter");
  expectProfile({ command: "bash", title: "Agent-Codex" }, "codex", "double-enter");
  expectProfile({ command: "PI", title: "t" }, "pi", "auto");
});

test("the command wins over the title when they disagree", () => {
  expectProfile({ command: "cursor-agent", title: "agent-pi" }, "cursor", "auto");
});

test("gemini names its observed approval prompts", () => {
  const waiting = resolveHarness({ command: "agy" }).waiting;
  assert.ok(waiting.some((re) => re.test("Do you want to proceed?")));
  assert.ok(waiting.some((re) => re.test("Accept this file edit?")));
});

test("opencode names its observed approval prompts", () => {
  const waiting = resolveHarness({ command: "opencode" }).waiting;
  assert.ok(waiting.some((re) => re.test("Permission required")));
  assert.ok(waiting.some((re) => re.test("Allow once")));
});

test("codex and pi carry only the generic prompt set", () => {
  const codex = resolveHarness({ command: "codex" }).waiting;
  const pi = resolveHarness({ command: "pi" }).waiting;
  assert.ok(codex.some((re) => re.test("Overwrite? (y/n)")));
  assert.ok(pi.some((re) => re.test("press enter to continue")));
  assert.ok(!codex.some((re) => re.test("Permission required")));
  assert.ok(!pi.some((re) => re.test("Do you want to proceed?")));
});
