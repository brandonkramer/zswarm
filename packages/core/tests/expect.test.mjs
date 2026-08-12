import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cliUsage,
  parseCliArgv,
  PARAMS,
  ZellijError,
} from "../dist/index.js";
import { assertPaneExpects } from "../dist/ops/guards.js";

const SCREEN = [
  "Claude Code v2",
  "> ready for a brief",
  "  (Pasted text #1)",
].join("\n");

test("assertPaneExpects passes when the screen contains the pattern", () => {
  assert.doesNotThrow(() =>
    assertPaneExpects(SCREEN, "ready for a brief", "terminal_4"),
  );
});

test("assertPaneExpects throws expect_missing when the pattern is absent", () => {
  assert.throws(
    () => assertPaneExpects(SCREEN, "$ ", "terminal_4"),
    (err) =>
      err instanceof ZellijError &&
      err.code === "expect_missing" &&
      err.message.includes("terminal_4") &&
      err.message.includes("$ "),
  );
});

test("assertPaneExpects is a case-insensitive substring, not a regex", () => {
  assert.doesNotThrow(() =>
    assertPaneExpects(SCREEN, "READY FOR A BRIEF", "terminal_4"),
  );
  assert.throws(
    () => assertPaneExpects(SCREEN, "ready.*brief", "terminal_4"),
    (err) => err instanceof ZellijError && err.code === "expect_missing",
  );
});

test("an empty expect is a no-op rather than an error", () => {
  assert.doesNotThrow(() => assertPaneExpects("", "", "terminal_4"));
  assert.doesNotThrow(() => assertPaneExpects(SCREEN, "", "terminal_4"));
});

test("schema exposes --expect and --since-last, and cliUsage still renders", () => {
  const expectParam = PARAMS.find((p) => p.name === "expect");
  assert.equal(expectParam?.type, "string");
  assert.deepEqual(expectParam?.flags, ["--expect"]);
  const sinceLast = PARAMS.find((p) => p.name === "sinceLast");
  assert.equal(sinceLast?.type, "boolean");
  assert.deepEqual(sinceLast?.flags, ["--since-last"]);

  const usage = cliUsage();
  assert.ok(usage.includes("--expect"));
  assert.ok(usage.includes("--since-last"));
  assert.deepEqual(parseCliArgv(["send", "--to", "3", "--expect", "Claude"]), {
    op: "send",
    to: "3",
    expect: "Claude",
  });
  assert.deepEqual(parseCliArgv(["status", "--since-last"]), {
    op: "status",
    sinceLast: true,
  });
});
