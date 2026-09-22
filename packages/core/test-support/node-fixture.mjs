import childProcess from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Run a fixture through Node on every OS: Windows cannot exec a shebang script.
 * Only substitute the executable/argv at the child-process boundary, retaining
 * the real runner, probes, timeout/kill handling, and per-path identity caches.
 * Tests using this helper must run serially within their test process.
 */
export function nodeFixture(t, source) {
  const dir = mkdtempSync(join(tmpdir(), "zswarm-node-fixture-"));
  const binary = join(dir, "fixture.mjs");
  writeFileSync(binary, source);
  const launches = [];
  const mocks = ["execFile", "spawn"].map((method) => {
    const original = childProcess[method];
    return t.mock.method(childProcess, method, (file, args, ...rest) => {
      if (file !== binary) return original(file, args, ...rest);
      launches.push({ args, at: Date.now(), timeoutMs: rest[0]?.timeout });
      return original(process.execPath, [binary, ...args], ...rest);
    });
  });
  syncBuiltinESMExports();
  t.after(() => {
    for (const mock of mocks) mock.mock.restore();
    syncBuiltinESMExports();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { dir, binary, launches };
}
