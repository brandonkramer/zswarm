#!/usr/bin/env node
import {
  ZellijError,
  cliUsage,
  createServeTunnelManager,
  dispatchZswarm,
  parseCliArgv,
  serveChildEnv,
  startServe,
} from "@zswarm/core";

import { readBodyFile } from "./input.js";
import { routingNotice } from "./output.js";

const argv = process.argv.slice(2);
if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
  process.stderr.write(cliUsage());
  process.exit(argv.length === 0 ? 2 : 0);
}

let args: Record<string, unknown>;
try {
  args = parseCliArgv(argv);
} catch (err) {
  const message = err instanceof ZellijError ? err.message : String(err);
  process.stderr.write(`${message}\n${cliUsage()}`);
  process.exit(2);
}

try {
  args = await readBodyFile(args);
} catch (err) {
  const code = err instanceof ZellijError ? err.code : "body_file_read";
  const message = err instanceof Error ? err.message : String(err);
  process.stdout.write(JSON.stringify({ ok: false, error: { code, message } }) + "\n");
  process.exit(1);
}

// TCP server holds the event loop; process.exit would tear it down.
if (args.op === "serve" && args.install !== true && args.clear !== true) {
  const listen = typeof args.listen === "string" ? args.listen : undefined;
  try {
    const { label } = await startServe(listen, (request) =>
      dispatchZswarm(request, undefined, { env: serveChildEnv(process.env) }),
      { token: process.env.ZSWARM_SERVE_TOKEN },
    );
    process.stdout.write(
      `${JSON.stringify({ ok: true, data: { listening: label } }, null, 2)}\n`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stdout.write(
      `${JSON.stringify({ ok: false, error: { code: "failed", message } }, null, 2)}\n`,
    );
    process.exit(1);
  }
} else {
  const serveTunnels = createServeTunnelManager({ persistIdle: false });
  const ac = new AbortController();
  const onStop = () => {
    if (!ac.signal.aborted) ac.abort();
  };
  process.once("SIGINT", onStop);
  process.once("SIGTERM", onStop);
  let exitCode = 1;
  try {
    const result = await dispatchZswarm(args, undefined, {
      signal: ac.signal,
      serveTunnels,
    });
    process.stderr.write(routingNotice(result, process.stderr.isTTY === true));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    exitCode = result.ok ? 0 : 1;
  } finally {
    process.off("SIGINT", onStop);
    process.off("SIGTERM", onStop);
    await serveTunnels.closeAll();
  }
  process.exit(exitCode);
}
