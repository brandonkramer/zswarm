import { ZellijError } from "../errors.js";
import { createGitClient, type GitClient } from "../git.js";
import { normalizeKeys } from "../keys.js";
import { createZellijClient, type ZellijClient } from "../zellij/client.js";
import type { ZellijPane } from "../zellij/panes.js";
import {
  assertOpAllowed,
  assertPaneAllowed,
  loadPolicy,
  type Policy,
} from "../policy.js";
import { createStateStore, type StateStore } from "../state.js";
import { busToPanes } from "../zellij/bus.js";
import { broadcast } from "./broadcast.js";
import { busChanged, busOp, busScreens, busSnapshot, busWait, planBus } from "./bus.js";
import {
  dumpLayoutOp,
  focusTarget,
  listTabsOp,
  renameTarget,
  stackTargets,
} from "./panes.js";
import { peerCheckpoint, peerDiff } from "./review.js";
import { attachKnownSender, deliverTo, withSenderLabel, selfPaneTitle } from "./delivery.js";
import {
  assertNotPlugin,
  assertNotSelf,
  assertExpectedScreen,
  assertWritable,
} from "./guards.js";
import { readDeliveryLog } from "./log.js";
import { awaitSignal, listSignals, postSignal } from "./signals.js";
import { spawnPane } from "./spawn.js";
import { observationBudget } from "./observation.js";
import { invocationContext, type RoutingContext } from "./routing.js";
import {
  DEFAULT_STATUS_TIMEOUT_MS,
  peerStatus,
} from "./status.js";
import { tailPane } from "./tail.js";
import { OP_NAMES } from "../schema.js";
import type { Clock, DispatchDeps, OpsResult } from "./types.js";
import {
  dumpMaxChars,
  fail,
  isTrue,
  isVerbose,
  numberArg,
  optionalString,
  paneViewBus,
  paneViewFull,
  paneViewSlim,
  throwIfAborted,
  truncateDumpText,
} from "./util.js";
import { waitForPane, type WaitBusTiming } from "./wait.js";
import { listPeerWorktrees, removePeerWorktree } from "./worktree.js";
import {
  callServe,
  installServeLogon,
  serveCallTimeout,
  uninstallServeLogon,
} from "./serve.js";

/**
 * Per-invocation routing from `--local` / `--ssh`. `--local` clears both SSH
 * and serve (and remote IPC). `--ssh` sets the destination for this call and
 * clears serve so the flag wins over a sticky ZSWARM_SERVE.
 */
export function resolveInvocationEnv(
  args: Record<string, unknown>,
  base: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const local = isTrue(args.local);
  const sshDest =
    typeof args.ssh === "string" && args.ssh.trim() ? args.ssh.trim() : null;
  const serveAddress = optionalString(args.serveAddress);
  if (Number(local) + Number(Boolean(sshDest)) + Number(Boolean(serveAddress)) > 1) {
    throw new ZellijError(
      "usage",
      "choose only one of --local, --ssh, or --serve",
    );
  }
  if (!local && !sshDest && !serveAddress) return base;
  const env = { ...base };
  if (serveAddress) {
    env.ZSWARM_SERVE = serveAddress;
    delete env.ZSWARM_SSH;
    return env;
  }
  if (local) {
    delete env.ZSWARM_SSH;
    delete env.ZSWARM_SSH_OPTS;
    delete env.ZSWARM_SSH_MODE;
    delete env.ZSWARM_SSH_BIN;
    delete env.ZSWARM_TMP;
    delete env.ZSWARM_REMOTE_BIN;
    delete env.ZSWARM_REMOTE_SHELL;
    delete env.ZSWARM_SERVE;
    delete env.ZSWARM_SERVE_TOKEN;
    return env;
  }
  env.ZSWARM_SSH = sshDest!;
  delete env.ZSWARM_SERVE;
  delete env.ZSWARM_SERVE_TOKEN;
  return env;
}
/** Same default `wait` applies: match when a needle is given, else idle. */
function waitMode(args: Record<string, unknown>): "idle" | "match" | "either" {
  const requested = typeof args.for === "string" ? args.for.trim() : "";
  if (requested === "match" || requested === "either" || requested === "idle") {
    return requested;
  }
  return typeof args.match === "string" && args.match ? "match" : "idle";
}

const SSH_GIT_OPS = new Set([
  "worktrees",
  "unworktree",
  "diff",
  "checkpoint",
]);

const SSH_LOCAL_BARRIER_OPS = new Set(["signal", "signals", "await"]);

/**
 * SSH only forwards Zellij. Git worktrees, diffs, and checkpoints stay on this
 * machine, so mixing them with a remote pane cwd is how you delete the wrong tree.
 * Client-local signal barriers cannot rendezvous with a remote crew either.
 */
function assertSshGitAllowed(
  env: NodeJS.ProcessEnv,
  op: string,
  args: Record<string, unknown>,
): void {
  if (!env.ZSWARM_SSH?.trim() || env.ZSWARM_SERVE?.trim()) return;
  const worktreeSpawn = op === "spawn" && optionalString(args.worktree);
  if (!worktreeSpawn && !SSH_GIT_OPS.has(op) && !SSH_LOCAL_BARRIER_OPS.has(op)) {
    return;
  }
  const why = SSH_LOCAL_BARRIER_OPS.has(op)
    ? "is a client-local barrier"
    : "uses local git";
  throw new ZellijError(
    "ssh_git_unsupported",
    `${op} ${why}; ZSWARM_SSH only forwards Zellij. Run zswarm serve on the host that owns the session`,
  );
}

async function resolveTarget(
  client: ZellijClient,
  args: Record<string, unknown>,
  state: StateStore,
  clock: Clock,
  env?: NodeJS.ProcessEnv,
  policy?: Policy,
  op?: string,
  signal?: AbortSignal,
): Promise<{ session: string; panes: ZellijPane[]; pane: ZellijPane }> {
  const to = String(args.to ?? "").trim();
  if (!to) throw new ZellijError("missing_peer", "to required");
  const budget = observationBudget(clock, numberArg(args, "timeoutMs", 30_000, { min: 1, max: 900_000 }), signal);
  const observeMs = numberArg(args, "observeMs", 1_000, { min: 0, max: 30_000 });
  const { session } = await client.resolveSession(optionalString(args.session), budget.require());
  const bus = isVerbose(args) ? null : await busSnapshot(client, state, session, clock, env, "status", {
    deadlineAt: budget.deadline, signal,
  });
  let panes: ZellijPane[] | null = null;
  if (bus) {
    const snapshot = busToPanes(bus.snapshot);
    try {
      client.resolvePane(snapshot, to);
      panes = snapshot;
    } catch { /* An absent title/command/ID gets a fresh direct observation. */ }
  }
  const until = Math.min(budget.deadline, clock.now() + observeMs);
  let pane: ZellijPane;
  let fresh = isTrue(args.fresh) || Boolean(op);
  for (;;) {
    const left = observeMs === 0 ? budget.require() : Math.min(budget.require(), Math.max(1, until - clock.now()));
    panes ??= await client.listPanes(session, left, { fresh });
    throwIfAborted(signal);
    try {
      pane = client.resolvePane(panes, to);
      break;
    } catch (err) {
      if (!(err instanceof ZellijError) || err.code !== "peer_not_found" || clock.now() >= until) throw err;
      await budget.pause(until);
      if (clock.now() >= until) throw err;
      panes = null;
      fresh = true;
    }
  }
  if (policy && op) assertPaneAllowed(policy, pane, op);
  return { session, panes, pane };
}

async function dispatchOperation(
  args: Record<string, unknown>,
  injected: ZellijClient | undefined,
  deps: DispatchDeps,
  context: RoutingContext,
  env: NodeJS.ProcessEnv,
): Promise<OpsResult> {
  const op = String(args.op ?? "");
  const verbose = isVerbose(args);
  const signal = deps.signal;
  const clock: Clock = {
    now: deps.now ?? (() => Date.now()),
    sleep:
      deps.sleep ??
      ((ms: number) =>
        new Promise<void>((resolve, reject) => {
          if (signal?.aborted) {
            reject(new ZellijError("cancelled", "operation cancelled"));
            return;
          }
          const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
          }, ms);
          const onAbort = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            reject(new ZellijError("cancelled", "operation cancelled"));
          };
          signal?.addEventListener("abort", onAbort, { once: true });
        })),
  };
  // Only the worktree ops need git, so the client is built on demand.
  let gitClient: GitClient | null = deps.git ?? null;
  const git = () => (gitClient ??= createGitClient());
  let stateStore: StateStore | null = deps.state ?? null;
  const state = () => (stateStore ??= createStateStore({ env }));
  try {
    throwIfAborted(signal);
    const policy = deps.policy ?? loadPolicy(env);
    // Policy gates the op before anything touches the session.
    assertOpAllowed(policy, op);
    assertSshGitAllowed(env, op, args);
    if (op === "serve") {
      if (isTrue(args.clear)) {
        const cleared = await uninstallServeLogon({
          platform: process.platform,
        });
        return { ok: true, data: cleared };
      }
      if (isTrue(args.install)) {
        const installed = await installServeLogon({
          listen: typeof args.listen === "string" ? args.listen : undefined,
        });
        return { ok: true, data: { ...installed, running: true } };
      }
      throw new ZellijError(
        "usage",
        "serve --listen is CLI-only; MCP/dispatch would hang the tool call. Run `zswarm serve --listen` in the session that owns Zellij",
      );
    }
    // An injected client is a unit-test (or in-process) Zellij; do not skip it
    // just because the host env has ZSWARM_SERVE set.
    if (!injected && env.ZSWARM_SERVE?.trim()) {
      const request = { ...attachKnownSender(args, env) };
      delete request.serveAddress; // Routing is consumed here, never forwarded back into a tunnel.
      return await callServe(
        env.ZSWARM_SERVE.trim(),
        request,
        serveCallTimeout(args),
        env.ZSWARM_SERVE_TOKEN,
        signal,
      );
    }
    const baseClient = injected ?? createZellijClient({ env, signal, cache: isTrue(args.fresh) ? false : undefined });
    const client: ZellijClient = {
      ...baseClient,
      get transport() { return baseClient.transport; },
      async resolveSession(...input) {
        const resolved = await baseClient.resolveSession(...input);
        context.session = resolved.session;
        context.origin.session = resolved.source;
        return resolved;
      },
    };
    switch (op) {
      case "sessions": {
        // Resolve SSH/IPC first so a Windows interactive crew is reachable
        // before --live filters EXITED rows.
        const listed = await client.listSessions();
        const transport = client.transport;
        const ipc = transport.ipc;
        if (
          ipc &&
          ipc.requested?.toLowerCase() === "auto" &&
          (ipc.status === "failed" ||
            ipc.status === "expired" ||
            ipc.status === "cancelled")
        ) {
          throw new ZellijError(
            "ipc_unreachable",
            `ZSWARM_TMP=auto could not discover the remote Zellij IPC directory (status=${ipc.status}). Set ZSWARM_TMP to the desktop TEMP, confirm ZSWARM_SSH_MODE=interactive with a logged-on user, or use zswarm serve. Refusing to treat EXITED rows as "no live crew".`,
          );
        }
        const includeExited = isTrue(args.all);
        const sessions = includeExited
          ? listed
          : listed.filter((s) => !s.exited);
        const data: Record<string, unknown> = {
          sessions,
          zellij: client.zellijPath,
          transport,
          filter: includeExited ? "all" : "live",
        };
        return { ok: true, data };
      }
      case "list": {
        const { session } = await client.resolveSession(
          typeof args.session === "string" ? args.session : undefined,
        );
        // The plugin's manifest carries no cwd or floating flag, so anything
        // verbose has to go the polling route.
        const observedBus = verbose
          ? null
          : await busSnapshot(client, state(), session, clock, env);
        const bus = observedBus?.snapshot.ready ? observedBus : null;
        const view = bus ? paneViewBus : verbose ? paneViewFull : paneViewSlim;
        const panes = (bus ? busToPanes(bus.snapshot) : await client.listPanes(session))
          .filter((p) => !p.isPlugin)
          .map(view)
          .sort((a, b) => a.id.localeCompare(b.id));
        const data: Record<string, unknown> = {
          session,
          source: bus ? "plugin" : "zellij",
          panes,
        };
        if (verbose && client.selfPaneId) data.self = client.selfPaneId;
        return { ok: true, data };
      }
      case "send": {
        const body = String(args.body ?? args.text ?? "");
        if (!body.trim()) throw new ZellijError("missing_body", "body required");
        const { session, pane, panes } = await resolveTarget(
          client,
          args,
          state(),
          clock,
          env,
          policy,
          op,
          signal,
        );
        assertWritable(client, pane, args, "send");
        await assertExpectedScreen(client, session, pane.id, args, signal);
        const labeled = withSenderLabel(args, {
          env,
          selfTitle: selfPaneTitle(client, panes),
        });
        const result = await deliverTo(client, state(), labeled, {
          session,
          pane,
          body,
          op: "send",
          at: clock.now(),
          clock,
        });
        if (!result.ok && result.error) {
          throw new ZellijError(result.error.code, result.error.message);
        }
        const data: Record<string, unknown> = {
          delivery: result.delivery,
          session,
          to: result.to,
          from: labeled.from,
          submitted: result.submitted,
        };
        if (verbose) data.pane = paneViewFull(pane);
        return { ok: true, data };
      }
      case "broadcast":
        return await broadcast(client, state(), args, clock, policy, env);
      case "keys":
      case "interrupt": {
        const { session, pane } = await resolveTarget(
          client,
          args,
          state(),
          clock,
          env,
          policy,
          op,
          signal,
        );
        assertWritable(client, pane, args, op);
        await assertExpectedScreen(client, session, pane.id, args, signal);
        const chars = typeof args.chars === "string" ? args.chars : "";
        if (op === "keys" && chars) {
          await client.writeChars({ session, paneId: pane.id, chars });
          if (isTrue(args.enter)) {
            await client.sendKeys({ session, paneId: pane.id, keys: ["Enter"] });
          }
          state().appendLog({
            at: clock.now(),
            op,
            session,
            to: pane.id,
            bytes: chars.length,
            ok: true,
            detail: "write-chars",
          });
          return {
            ok: true,
            data: {
              session,
              to: pane.id,
              delivery: "zellij_write_chars",
              chars: chars.length,
              enter: isTrue(args.enter),
            },
          };
        }
        const keys =
          op === "interrupt"
            ? normalizeKeys(args.keys ?? (isTrue(args.hard) ? "Ctrl c" : "Esc"))
            : normalizeKeys(args.keys);
        const sent = await client.sendKeys({ session, paneId: pane.id, keys });
        if (op === "keys" && isTrue(args.enter)) {
          await client.sendKeys({ session, paneId: pane.id, keys: ["Enter"] });
        }
        state().appendLog({
          at: clock.now(),
          op,
          session,
          to: sent.paneId,
          ok: true,
          detail: sent.keys.join(" "),
        });
        return {
          ok: true,
          data: {
            session,
            to: sent.paneId,
            delivery: "zellij_send_keys",
            keys: sent.keys,
          },
        };
      }
      case "dump": {
        const { session, pane } = await resolveTarget(
          client,
          args,
          state(),
          clock,
          env,
          undefined,
          undefined,
          signal,
        );
        const dumped = await client.dumpPane({
          session,
          paneId: pane.id,
          full: isTrue(args.full),
        });
        const max = dumpMaxChars(args);
        const keep = isTrue(args.head) ? "head" : "tail";
        const clipped = truncateDumpText(dumped.text, max, keep);
        return {
          ok: true,
          data: {
            session: dumped.session,
            to: dumped.paneId,
            text: clipped.text,
            truncated: clipped.truncated,
            chars: clipped.chars,
            max,
          },
        };
      }
      case "tail": {
        const target = await resolveTarget(
          client,
          args,
          state(),
          clock,
          env,
          undefined,
          undefined,
          signal,
        );
        return await tailPane(client, state(), args, target);
      }
      case "wait": {
        const target = await resolveTarget(
          client,
          args,
          state(),
          clock,
          env,
          undefined,
          undefined,
          signal,
        );
        // The plugin holds one pipe for the whole wait and polls far tighter
        // than spawning a process allows. It declines a regex needle — it has
        // no engine — and then this is the loop that runs.
        const viaBus = isTrue(args.regex)
          ? undefined
          : (timing: WaitBusTiming) =>
              busWait(
                client,
                state(),
                target.session,
                {
                  pane: target.pane.id,
                  for: waitMode(args),
                  match: typeof args.match === "string" ? args.match : null,
                  ignoreCase: isTrue(args.ignoreCase),
                  ...timing,
                },
                env,
              );
        return await waitForPane(
          client,
          target,
          args,
          clock,
          viaBus,
          deps.signal,
        );
      }
      case "status": {
        // One overall deadline covering session resolve, bus snapshot, IPC,
        // and screen samples — not just the dump loop inside peerStatus.
        const statusBudget = numberArg(
          args,
          "timeoutMs",
          DEFAULT_STATUS_TIMEOUT_MS,
          { min: 1_000, max: 900_000 },
        );
        const deadlineAt = clock.now() + statusBudget;
        const remaining = (): number => Math.max(0, deadlineAt - clock.now());
        const setupBudget = (): number => {
          throwIfAborted(signal);
          const left = remaining();
          if (left <= 0) {
            throw new ZellijError("zellij_failed", "status timed out during setup");
          }
          return left;
        };
        throwIfAborted(signal);

        const { session } = await client.resolveSession(
          typeof args.session === "string" ? args.session : undefined,
          setupBudget(),
        );
        throwIfAborted(signal);
        // Once the session is known, verbose metadata and the bus manifest
        // are independent reads. Both consume this operation's remaining time.
        const readBus = () => remaining() <= 0 ? Promise.resolve(null)
          : busSnapshot(client, state(), session, clock, env, "status", { deadlineAt, signal });
        let observedBus: Awaited<ReturnType<typeof busSnapshot>>;
        let detailedPanes: ZellijPane[] | undefined;
        if (verbose) {
          const reads = await Promise.allSettled([
            readBus(), client.listPanes(session, setupBudget(), { fresh: true }),
          ]);
          throwIfAborted(signal);
          if (reads[1].status === "rejected") throw reads[1].reason;
          if (reads[0].status === "rejected") throw reads[0].reason;
          observedBus = reads[0].value;
          detailedPanes = reads[1].value;
        } else {
          observedBus = await readBus();
        }
        const bus = observedBus?.snapshot.ready ? observedBus : null;
        throwIfAborted(signal);
        // Always hand peerStatus the resolved session (and panes) so it does
        // not spend the overall budget resolving again.
        const panes = detailedPanes ?? (bus
          ? busToPanes(bus.snapshot)
          : await client.listPanes(session, setupBudget()));
        throwIfAborted(signal);
        let supplied: {
          session: string;
          panes: ReturnType<typeof busToPanes>;
          source: "plugin" | "zellij";
          readScreens?: (
            paneIds: string[],
            timeoutMs: number,
          ) => Promise<Map<string, string> | null>;
          readChanged?: (
            paneIds: string[],
            timeoutMs: number,
          ) => Promise<Map<
            string,
            { changed: boolean; first: boolean; screen: string }
          > | null>;
        } = {
          session,
          panes,
          source: bus && !verbose ? "plugin" : "zellij",
        };
        if (bus) {
          supplied = {
            ...supplied,
            readScreens: (paneIds: string[], timeoutMs: number) =>
              busScreens(
                client,
                state(),
                session,
                paneIds,
                clock,
                env,
                timeoutMs,
              ),
            readChanged: async (paneIds: string[], timeoutMs: number) => {
              const reply = await busChanged(
                client,
                state(),
                session,
                paneIds,
                env,
                timeoutMs,
              );
              if (!reply) return null;
              return new Map(
                reply.panes.map((p) => [
                  p.id,
                  { changed: p.changed, first: p.first, screen: p.screen },
                ]),
              );
            },
          };
        }
        const only = typeof args.to === "string" ? args.to.trim() : "";
        if (bus && only) {
          try {
            client.resolvePane(supplied.panes, only);
          } catch {
            // Command-shaped `to` needs the polled list; re-fetch without bus.
            const polled = await client.listPanes(session, setupBudget());
            supplied = { ...supplied, session, panes: polled, source: "zellij" };
          }
        }
        const result = await peerStatus(client, args, clock, supplied, {
          deadlineAt,
          signal,
        });
        if (result.ok && result.data && typeof result.data === "object") {
          const data = result.data as Record<string, unknown>;
          data.polling = {
            busAvailable: Boolean(bus),
            ...(bus ? {} : { reason: planBus(client, state(), env, session).reason }),
            ...(client.remote ? {
              recommendation: "For frequent status calls, run zswarm serve beside Zellij and use --serve 127.0.0.1:9419 through an SSH tunnel; direct SSH cannot use the local event bus.",
            } : {}),
          };
        }
        return result;
      }
      case "bus":
        return await busOp(client, state(), args, clock, env, policy);
      case "signal":
        return postSignal(state(), args, clock);
      case "signals":
        return listSignals(state());
      case "await":
        return await awaitSignal(state(), args, clock);
      case "log":
        return readDeliveryLog(state(), args);
      case "rename":
        return await renameTarget(client, args, policy);
      case "focus":
        return await focusTarget(client, args, policy);
      case "tabs":
        return await listTabsOp(client, args);
      case "layout":
        return await dumpLayoutOp(client, args);
      case "stack":
        return await stackTargets(client, args, policy);
      case "diff":
        return await peerDiff(git(), args);
      case "checkpoint":
        return await peerCheckpoint(git(), args, clock);
      case "spawn":
        return await spawnPane(client, args, deps.git, clock, signal);
      case "worktrees":
        return await listPeerWorktrees(git(), client, args);
      case "unworktree":
        return await removePeerWorktree(git(), client, args);
      case "close": {
        const { session, pane } = await resolveTarget(
          client,
          args,
          state(),
          clock,
          env,
          policy,
          op,
          signal,
        );
        // Not assertWritable: closing an exited pane is the point of close.
        assertNotPlugin(pane, "close");
        assertNotSelf(client, pane, args, "close");
        const closed = await client.closePane({ session, paneId: pane.id });
        state().appendLog({
          at: clock.now(),
          op: "close",
          session,
          to: closed.paneId,
          ok: true,
        });
        return {
          ok: true,
          data: { session: closed.session, closed: closed.paneId },
        };
      }
      default:
        throw new ZellijError(
          "usage",
          `zswarm requires op=${OP_NAMES.join("|")}`,
        );
    }
  } catch (err) {
    return fail(err);
  }
}

/** Shared MCP/CLI dispatch, with invocation routing on successes and failures. */
export async function dispatchZswarm(
  args: Record<string, unknown>,
  injected?: ZellijClient,
  deps: DispatchDeps = {},
): Promise<OpsResult> {
  try {
    const env = resolveInvocationEnv(args, deps.env ?? process.env);
    const context = invocationContext(args, env, injected?.transport);
    const result = await dispatchOperation(args, injected, deps, context, env);
    if (context.transport === "serve" && result.context) {
      context.server = result.context;
      context.session = result.context.session;
      context.origin.session = result.context.origin.session;
    } else if (context.transport === "serve" && result.ok && result.data && typeof result.data === "object") {
      const session = (result.data as Record<string, unknown>).session;
      if (typeof session === "string") {
        context.session = session;
        context.origin.session = "server";
      }
    }
    return { ...result, context };
  } catch (err) {
    return fail(err);
  }
}
