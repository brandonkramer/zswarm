// Unit/integration fixtures select their own routing. A developer's active
// crew must never become the test suite's default host, pane, or state store.
for (const key of Object.keys(process.env)) {
  if (/^(ZSWARM|ZELLIJ)_/.test(key)) delete process.env[key];
}
