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
import { busChanged, busOp, busScreens, busSnapshot, busWait } from "./bus.js";
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
  assertPaneExpects,
  assertWritable,
} from "./guards.js";
import { readDeliveryLog } from "./log.js";
import { awaitSignal, listSignals, postSignal } from "./signals.js";
import { spawnPane } from "./spawn.js";
import { peerStatus } from "./status.js";
import { tailPane } from "./tail.js";
import { OP_NAMES } from "../schema.js";
import type { Clock, DispatchDeps, OpsResult } from "./types.js";
import {
  dumpMaxChars,
  fail,
  isTrue,
  isVerbose,
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
): Promise<{ session: string; panes: ZellijPane[]; pane: ZellijPane }> {
  const to = String(args.to ?? "").trim();
  if (!to) throw new ZellijError("missing_peer", "to required");
  const { session } = await client.resolveSession(
    typeof args.session === "string" ? args.session : undefined,
  );
  // The plugin manifest carries no cwd/command/floating, so verbose
  // responses have to go the polling route.
  const bus = isVerbose(args)
    ? null
    : await busSnapshot(client, state, session, clock, env);
  let panes: ZellijPane[] | null = null;
  if (bus) {
    const busPanes = busToPanes(bus.snapshot);
    try {
      client.resolvePane(busPanes, to);
      panes = busPanes;
    } catch {
      // A command-shaped `to` only matches the polled list.
    }
  }
  if (!panes) panes = await client.listPanes(session);
  const pane = client.resolvePane(panes, to);
  if (policy && op) assertPaneAllowed(policy, pane, op);
  return { session, panes, pane };
}

/** Shared MCP/CLI dispatch for zswarm ops. */
export async function dispatchZswarm(
  args: Record<string, unknown>,
  injected?: ZellijClient,
  deps: DispatchDeps = {},
): Promise<OpsResult> {
  const op = String(args.op ?? "");
  const verbose = isVerbose(args);
  const signal = deps.signal;
  throwIfAborted(signal);
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
          const timer = setTimeout(resolve, ms);
          const onAbort = () => {
            clearTimeout(timer);
            reject(new ZellijError("cancelled", "operation cancelled"));
          };
          signal?.addEventListener("abort", onAbort, { once: true });
        })),
  };
  // Only the worktree ops need git, so the client is built on demand.
  let gitClient: GitClient | null = deps.git ?? null;
  const git = () => (gitClient ??= createGitClient());
  let stateStore: StateStore | null = deps.state ?? null;
  const state = () => (stateStore ??= createStateStore());
  const policy = deps.policy ?? loadPolicy(deps.env);
  const env = deps.env ?? process.env;
  try {
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
      return await callServe(
        env.ZSWARM_SERVE.trim(),
        attachKnownSender(args, env),
        serveCallTimeout(args),
        env.ZSWARM_SERVE_TOKEN,
      );
    }
    const client = injected ?? createZellijClient({ env: deps.env, signal });
    switch (op) {
      case "sessions": {
        const sessions = await client.listSessions();
        return { ok: true, data: { sessions, zellij: client.zellijPath } };
      }
      case "list": {
        const { session } = await client.resolveSession(
          typeof args.session === "string" ? args.session : undefined,
        );
        // The plugin's manifest carries no cwd or floating flag, so anything
        // verbose has to go the polling route.
        const bus = verbose
          ? null
          : await busSnapshot(client, state(), session, clock, deps.env);
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
          deps.env,
          policy,
          op,
        );
        assertWritable(client, pane, args, "send");
        // A pane that dropped back to a shell will *run* the message. There is
        // no reliable way to tell an agent from a prompt, so the caller names
        // something the screen must show first.
        const expect = typeof args.expect === "string" ? args.expect.trim() : "";
        if (expect) {
          const screen = await client.dumpPane({ session, paneId: pane.id });
          assertPaneExpects(screen.text, expect, pane.id);
        }
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
          deps.env,
          policy,
          op,
        );
        assertWritable(client, pane, args, op);
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
          deps.env,
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
          deps.env,
        );
        return await tailPane(client, state(), args, target);
      }
      case "wait": {
        const target = await resolveTarget(
          client,
          args,
          state(),
          clock,
          deps.env,
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
                deps.env,
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
        const { session } = await client.resolveSession(
          typeof args.session === "string" ? args.session : undefined,
        );
        // Verbose reports cwd and command, which the plugin manifest lacks.
        const bus = verbose
          ? null
          : await busSnapshot(client, state(), session, clock, deps.env);
        let supplied = bus
          ? {
              session,
              panes: busToPanes(bus.snapshot),
              source: "plugin" as const,
              // Sampling is 2N dumps; the plugin reads them all in one pipe.
              readScreens: (paneIds: string[]) =>
                busScreens(client, state(), session, paneIds, clock, deps.env),
              readChanged: async (paneIds: string[]) => {
                const reply = await busChanged(
                  client,
                  state(),
                  session,
                  paneIds,
                  deps.env,
                );
                if (!reply) return null;
                return new Map(
                  reply.panes.map((p) => [
                    p.id,
                    { changed: p.changed, first: p.first, screen: p.screen },
                  ]),
                );
              },
            }
          : null;
        const only = typeof args.to === "string" ? args.to.trim() : "";
        if (supplied && only) {
          try {
            client.resolvePane(supplied.panes, only);
          } catch {
            // The manifest has no commands, so a command-shaped `to` only
            // resolves against the polled list.
            supplied = null;
          }
        }
        return await peerStatus(client, args, clock, supplied);
      }
      case "bus":
        return await busOp(client, state(), args, clock, deps.env, policy);
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
        return await spawnPane(client, args, deps.git);
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
          deps.env,
          policy,
          op,
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
