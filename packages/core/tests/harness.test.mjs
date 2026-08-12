import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveHarness } from "../dist/harness.js";

const WIN = "C:\\Users\\alice\\AppData\\Roaming\\npm";

test("codex resolves from a command path and defaults to double-enter", () => {
  assert.deepEqual(
    resolveHarness({ command: `${WIN}\\codex.cmd`, title: "codex" }),
    { name: "codex", submit: "double-enter" },
  );
});

test("codex resolves from the title when the command is just a shell", () => {
  assert.deepEqual(
    resolveHarness({ command: "bash", title: "agent-codex" }),
    { name: "codex", submit: "double-enter" },
  );
});

test("cursor resolves from a command path and defaults to auto", () => {
  assert.deepEqual(
    resolveHarness({ command: `${WIN}\\cursor-agent.exe`, title: "cursor" }),
    { name: "cursor", submit: "auto" },
  );
});

test("cursor resolves from the title when the command is generic", () => {
  assert.deepEqual(
    resolveHarness({ command: "bash", title: "agent-cursor" }),
    { name: "cursor", submit: "auto" },
  );
});

test("opencode resolves from a command path and defaults to auto", () => {
  assert.deepEqual(
    resolveHarness({ command: `${WIN}\\opencode.exe`, title: "opencode" }),
    { name: "opencode", submit: "auto" },
  );
});

test("opencode resolves from the title when the command is generic", () => {
  assert.deepEqual(
    resolveHarness({ command: "bash", title: "agent-opencode" }),
    { name: "opencode", submit: "auto" },
  );
});

test("gemini resolves from the agy command and defaults to auto", () => {
  assert.deepEqual(
    resolveHarness({ command: `${WIN}\\agy.exe`, title: "gemini" }),
    { name: "gemini", submit: "auto" },
  );
});

test("gemini resolves from a gemini command and from its title", () => {
  assert.deepEqual(
    resolveHarness({ command: "gemini", title: "g" }),
    { name: "gemini", submit: "auto" },
  );
  assert.deepEqual(
    resolveHarness({ command: "bash", title: "agent-gemini" }),
    { name: "gemini", submit: "auto" },
  );
});

test("pi resolves from a scoop shim path and defaults to auto", () => {
  assert.deepEqual(
    resolveHarness({
      command: "C:\\Users\\alice\\scoop\\persist\\nodejs\\bin\\pi.cmd",
      title: "pi",
    }),
    { name: "pi", submit: "auto" },
  );
});

test("pi resolves from a bare command and from its title", () => {
  assert.deepEqual(
    resolveHarness({ command: "pi", title: "term" }),
    { name: "pi", submit: "auto" },
  );
  assert.deepEqual(
    resolveHarness({ command: "bash", title: "agent-pi" }),
    { name: "pi", submit: "auto" },
  );
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
    { name: "unknown", submit: "auto" },
  );
  assert.deepEqual(
    resolveHarness({
      command: "C:\\Users\\alice\\projects\\spike\\pipe\\piper\\bin\\bash.exe",
      title: "builder",
    }),
    { name: "unknown", submit: "auto" },
  );
  assert.deepEqual(
    resolveHarness({ command: "bash", title: "pipeline status" }),
    { name: "unknown", submit: "auto" },
  );
  assert.deepEqual(
    resolveHarness({ command: "bash", title: "api-docs" }),
    { name: "unknown", submit: "auto" },
  );
});

test("an unknown pane returns unknown with auto submit", () => {
  assert.deepEqual(
    resolveHarness({ command: "bash", title: "builder" }),
    { name: "unknown", submit: "auto" },
  );
});

test("missing or null command and title never throw", () => {
  assert.deepEqual(resolveHarness({}), { name: "unknown", submit: "auto" });
  assert.deepEqual(resolveHarness({ command: null, title: null }), {
    name: "unknown",
    submit: "auto",
  });
  assert.deepEqual(resolveHarness({ command: undefined, title: undefined }), {
    name: "unknown",
    submit: "auto",
  });
  assert.deepEqual(resolveHarness({ command: "", title: "" }), {
    name: "unknown",
    submit: "auto",
  });
});

test("matching is case-insensitive on command and title", () => {
  assert.deepEqual(
    resolveHarness({ command: "CodeX", title: "c" }),
    { name: "codex", submit: "double-enter" },
  );
  assert.deepEqual(
    resolveHarness({ command: "bash", title: "Agent-Codex" }),
    { name: "codex", submit: "double-enter" },
  );
  assert.deepEqual(
    resolveHarness({ command: "PI", title: "t" }),
    { name: "pi", submit: "auto" },
  );
});

test("the command wins over the title when they disagree", () => {
  assert.deepEqual(
    resolveHarness({ command: "cursor-agent", title: "agent-pi" }),
    { name: "cursor", submit: "auto" },
  );
});
