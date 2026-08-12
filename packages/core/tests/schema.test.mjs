import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cliUsage,
  mcpInputSchema,
  parseCliArgv,
  OP_NAMES,
  PARAMS,
} from "../dist/index.js";

test("MCP schema exposes exactly the shared param table", () => {
  const schema = mcpInputSchema();
  assert.deepEqual(schema.properties.op.enum, [...OP_NAMES]);
  assert.deepEqual(schema.required, ["op"]);
  assert.equal(schema.additionalProperties, false);
  for (const param of PARAMS) {
    assert.ok(schema.properties[param.name], `missing ${param.name}`);
    assert.ok(
      schema.properties[param.name].description,
      `${param.name} has no description`,
    );
  }
  assert.equal(
    Object.keys(schema.properties).length,
    PARAMS.length + 1,
    "schema and PARAMS drifted",
  );
  // stringOrArray params must stay callable with either shape.
  assert.ok(Array.isArray(schema.properties.keys.anyOf));
  assert.ok(Array.isArray(schema.properties.command.anyOf));
  assert.deepEqual(schema.properties.for.enum, ["idle", "match", "either"]);
});

test("no two params claim the same CLI flag", () => {
  const seen = new Map();
  for (const param of PARAMS) {
    for (const flag of param.flags) {
      assert.equal(
        seen.get(flag),
        undefined,
        `${flag} claimed by both ${seen.get(flag)} and ${param.name}`,
      );
      seen.set(flag, param.name);
    }
  }
});

test("parseCliArgv maps flags onto dispatch args", () => {
  assert.deepEqual(parseCliArgv(["list", "--verbose"]), {
    op: "list",
    verbose: true,
  });
  assert.deepEqual(
    parseCliArgv(["wait", "--to", "3", "--idle-ms", "1500", "--ignore-case"]),
    { op: "wait", to: "3", idleMs: 1500, ignoreCase: true },
  );
  assert.deepEqual(
    parseCliArgv(["keys", "--to", "3", "--key", "Ctrl c", "--key", "esc"]),
    { op: "keys", to: "3", keys: ["Ctrl c", "esc"] },
  );
  assert.deepEqual(parseCliArgv(["spawn", "--close-on-exit", "--cwd", "/repo"]), {
    op: "spawn",
    closeOnExit: true,
    cwd: "/repo",
  });
});

test("parseCliArgv keeps the positional shorthands", () => {
  assert.deepEqual(parseCliArgv(["send", "terminal_2", "ping"]), {
    op: "send",
    to: "terminal_2",
    body: "ping",
  });
  assert.deepEqual(parseCliArgv(["dump", "2"]), { op: "dump", to: "2" });
  // list takes no target, so a bare argument is an error rather than a silent to=
  assert.throws(() => parseCliArgv(["list", "2"]), /unexpected argument/);
});

test("parseCliArgv rejects unknown flags and missing values", () => {
  assert.throws(() => parseCliArgv(["send", "--nope"]), /unknown arg/);
  assert.throws(() => parseCliArgv(["send", "--to"]), /needs a value/);
});

test("cliUsage lists every flagged param", () => {
  const usage = cliUsage();
  for (const param of PARAMS) {
    if (param.flags.length === 0) continue;
    assert.ok(usage.includes(param.flags[0]), `usage missing ${param.flags[0]}`);
  }
  for (const op of OP_NAMES) assert.ok(usage.includes(op));
});

test("parseCliArgv finds the op when flags come first", () => {
  // `zswarm --session crew list` used to report `--session` as an unknown op.
  assert.deepEqual(parseCliArgv(["--session", "crew", "list"]), {
    op: "list",
    session: "crew",
  });
  // An op in first position still wins, so a positional body that happens to
  // be an op name is not stolen.
  assert.deepEqual(parseCliArgv(["send", "reviewer", "list"]), {
    op: "send",
    to: "reviewer",
    body: "list",
  });
  // Nothing op-shaped anywhere still fails, and names the offending token.
  assert.throws(() => parseCliArgv(["--session", "crew"]), /usage|unexpected/i);
});
