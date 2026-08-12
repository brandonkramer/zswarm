import { test } from "node:test";
import assert from "node:assert/strict";
import { classify } from "../dist/ops/status.js";
import { resolveHarness } from "../dist/harness.js";

// Profiles as the harness layer resolves them from realistic pane metadata.
const gemini = resolveHarness({ command: "agy", title: "agent-gemini" });
const opencode = resolveHarness({ command: "opencode", title: "agent-opencode" });
const pi = resolveHarness({ command: "pi", title: "agent-pi" });
const unknown = resolveHarness({ command: "bash", title: "builder" });

// Real chrome: the bottom of a full-screen TUI, where the prompt hides.
const GEMINI_CHROME = [
  "> 1. Yes",
  "  2. No",
  "hint: up/down to navigate",
  "up/down Navigate - tab Amend - ctrl+g edit",
  "esc to cancel",
];
const OPENCODE_CHROME = [
  "Access external directory /home/me/data",
  " Allow once   Allow always   Reject",
  "hint: tab to move, enter to choose",
  "ctrl+f fullscreen  select  enter confirm",
  "esc to cancel",
];
const GENERIC_CHROME = [">", "hint: y = yes, n = no", "hint: ctrl+c to cancel", "waiting for input", "esc to cancel"];

/** Build a screen with the prompt `above` working lines and chrome `below`. */
function tui(prompt, above = [], below = []) {
  return [...above, prompt, ...below].join("\n");
}

test("gemini's proceed prompt reads waiting 5+ lines above the bottom", () => {
  const screen = tui("Do you want to proceed?", ["[00:00] working..."], GEMINI_CHROME);
  assert.equal(classify({ exited: false, before: screen, after: screen, profile: gemini }), "waiting");
});

test("gemini's accept-file-edit prompt reads waiting", () => {
  const screen = tui("Accept this file edit?", ["[00:00] working..."], GEMINI_CHROME);
  assert.equal(classify({ exited: false, before: screen, after: screen, profile: gemini }), "waiting");
});

test("opencode's permission prompt reads waiting", () => {
  const screen = tui("Permission required", ["[00:00] working..."], OPENCODE_CHROME);
  assert.equal(classify({ exited: false, before: screen, after: screen, profile: opencode }), "waiting");
});

test("opencode's allow-once prompt reads waiting", () => {
  const screen = tui("Allow once", ["[00:00] working..."], OPENCODE_CHROME);
  assert.equal(classify({ exited: false, before: screen, after: screen, profile: opencode }), "waiting");
});

test("generic prompts read waiting for an unknown pane", () => {
  for (const prompt of ["Overwrite? (y/n)", "Save changes? [y/n]", "press enter to continue"]) {
    const screen = tui(prompt, ["[00:00] working..."], GENERIC_CHROME);
    assert.equal(
      classify({ exited: false, before: screen, after: screen, profile: unknown }),
      "waiting",
      prompt,
    );
  }
});

test("a pane that moved is busy even when the output holds a question mark", () => {
  const after = "did you mean option B? (y/n)?? still typing...";
  assert.equal(
    classify({ exited: false, before: "old", after, profile: unknown }),
    "busy",
  );
});

test("a question mark in still output is not a named prompt", () => {
  const screen = ["did you mean option B?", "hint: press ? for help", "last output"].join("\n");
  assert.equal(classify({ exited: false, before: screen, after: screen, profile: unknown }), "idle");
});

test("an idle shell prompt is not waiting", () => {
  const shell = "alice@host:~/projects/zswarm$";
  assert.equal(classify({ exited: false, before: shell, after: shell, profile: unknown }), "idle");
  assert.equal(classify({ exited: false, before: shell, after: shell, profile: pi }), "idle");
});

test("the word confirm alone is not a prompt", () => {
  const screen = "result saved - press enter to confirm and exit\nDone.";
  assert.equal(classify({ exited: false, before: screen, after: screen, profile: pi }), "idle");
});

test("opencode's chrome line alone is idle for an unknown pane", () => {
  // Bare "confirm" in a status bar must not read as a prompt, on the profile
  // path or the legacy last-line fallback.
  const chrome = "ctrl+f fullscreen  select  enter confirm";
  assert.equal(
    classify({ exited: false, before: chrome, after: chrome, profile: unknown }),
    "idle",
  );
  assert.equal(classify({ exited: false, before: chrome, after: chrome }), "idle");
});

test("legacy fallback still accepts the affirmative question forms", () => {
  for (const prompt of ["Continue?", "Proceed?", "Overwrite?", "Confirm?", "Press enter to continue", "Password: ", "Passphrase: "]) {
    assert.equal(
      classify({ exited: false, before: prompt, after: prompt }),
      "waiting",
      prompt,
    );
  }
});

test("legacy fallback does not take bare chrome terms", () => {
  for (const chrome of [
    "ctrl+f fullscreen  select  enter confirm",
    "press enter to confirm and exit",
    "continue (after reboot)",
    "press enter to exit",
  ]) {
    assert.equal(classify({ exited: false, before: chrome, after: chrome }), "idle", chrome);
  }
});

test("unknown does not claim gemini- or opencode-only prompts", () => {
  // False negatives are the safe direction: an unclaimed prompt only means
  // the dispatcher leaves the pane alone.
  for (const prompt of ["Do you want to proceed?", "Accept this file edit?", "Permission required", "Allow once"]) {
    const screen = tui(prompt, ["[00:00] working..."], GENERIC_CHROME);
    assert.equal(classify({ exited: false, before: screen, after: screen, profile: unknown }), "idle", prompt);
  }
});

test("gemini does not claim opencode-only prompts", () => {
  const screen = tui("Permission required", ["[00:00] working..."], GEMINI_CHROME);
  assert.equal(classify({ exited: false, before: screen, after: screen, profile: gemini }), "idle");
});

test("full-screen chrome alone does not read as waiting", () => {
  const screen = tui("[00:00] working...", [], GEMINI_CHROME);
  assert.equal(classify({ exited: false, before: screen, after: screen, profile: gemini }), "idle");
});

test("a prompt scrolled out of the 24-line window is not claimed", () => {
  const screen = [
    "Do you want to proceed?",
    ...Array.from({ length: 30 }, (_, i) => `[${i}] working...`),
  ].join("\n");
  assert.equal(classify({ exited: false, before: screen, after: screen, profile: gemini }), "idle");
});

// Real gemini six-option MCP-permission menu, wrapped. Counted from the
// bottom: 1 esc to cancel, 2 up/down Navigate, 3 settings.json), ..., 11
// > 1. Yes, 12 Do you want to proceed?, 13 zswarm (server: zswarm). The
// question sits 12 non-empty lines up — outside the old 10-line window.
const GEMINI_SIX_OPTION = [
  "zswarm (server: zswarm)",
  "Do you want to proceed?",
  "> 1. Yes",
  "2. Yes, and always allow 'zswarm/zswarm' in this",
  "conversation",
  "3. Yes, and always allow 'zswarm/zswarm' (Persist to",
  "settings.json)",
  "4. No",
  "5. No, and always deny 'zswarm/zswarm' in this conversation",
  "6. No, and always deny 'zswarm/zswarm' (Persist to",
  "settings.json)",
  "up/down Navigate - tab Amend - ctrl+g edit/expand command",
  "esc to cancel                          Gemini 3.6 Flash - high",
].join("\n");

test("gemini's six-option MCP menu, 12 lines up, reads waiting", () => {
  assert.equal(
    classify({ exited: false, before: GEMINI_SIX_OPTION, after: GEMINI_SIX_OPTION, profile: gemini }),
    "waiting",
  );
});

test("classify keeps exited, busy, and idle semantics", () => {
  assert.equal(classify({ exited: true, before: "x", after: "x", profile: gemini }), "exited");
  assert.equal(classify({ exited: false, before: "a", after: "b", profile: gemini }), "busy");
  const idle = tui("[00:00] working...", [], GEMINI_CHROME);
  assert.equal(classify({ exited: false, before: idle, after: idle, profile: gemini }), "idle");
});

test("classify without a profile keeps the legacy last-line question check", () => {
  assert.equal(
    classify({ exited: false, before: "Overwrite? (y/n)", after: "Overwrite? (y/n)" }),
    "waiting",
  );
  assert.equal(classify({ exited: false, before: "D:\\repo>", after: "D:\\repo>" }), "idle");
});

test("prompt matching is case-insensitive", () => {
  const screen = tui("DO YOU WANT TO PROCEED?", [], GEMINI_CHROME);
  assert.equal(classify({ exited: false, before: screen, after: screen, profile: gemini }), "waiting");
});

test("prompt detection tolerates CRLF and trailing blank lines", () => {
  const screen = [
    "[00:00] working...\r",
    "Do you want to proceed?\r",
    "> 1. Yes\r",
    "  2. No\r",
    "esc to cancel\r",
    "",
    " ",
  ].join("\n");
  assert.equal(classify({ exited: false, before: screen, after: screen, profile: gemini }), "waiting");
});
