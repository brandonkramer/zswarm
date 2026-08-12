import { ZellijError } from "../errors.js";
import { createGitClient, type GitClient } from "../git.js";
import { normalizeKeys } from "../keys.js";
import { createZellijClient, type ZellijClient } from "../zellij/client.js";
import type { ZellijPane } from "../zellij/panes.js";
import { createStateStore, type StateStore } from "../state.js";
import { broadcast } from "./broadcast.js";
import { deliverTo } from "./delivery.js";
import { assertNotPlugin, assertNotSelf, assertWritable } from "./guards.js";
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
  paneViewFull,
  paneViewSlim,
  truncateDumpText,
} from "./util.js";
import { waitForPane } from "./wait.js";
import { listPeerWorktrees, removePeerWorktree } from "./worktree.js";

async function resolveTarget(
  client: ZellijClient,
  args: Record<string, unknown>,
): Promise<{ session: string; panes: ZellijPane[]; pane: ZellijPane }> {
  const to = String(args.to ?? "").trim();
  if (!to) throw new ZellijError("missing_peer", "to required");
  const { session } = await client.resolveSession(
    typeof args.session === "string" ? args.session : undefined,
  );
  const panes = await client.listPanes(session);
  return { session, panes, pane: client.resolvePane(panes, to) };
}

/** Shared MCP/CLI dispatch for zswarm ops. */
export async function dispatchZswarm(
  args: Record<string, unknown>,
  client: ZellijClient = createZellijClient(),
  deps: DispatchDeps = {},
): Promise<OpsResult> {
  const op = String(args.op ?? "");
  const verbose = isVerbose(args);
  const clock: Clock = {
    now: deps.now ?? (() => Date.now()),
    sleep:
      deps.sleep ??
      ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))),
  };
  // Only the worktree ops need git, so the client is built on demand.
  let gitClient: GitClient | null = deps.git ?? null;
  const git = () => (gitClient ??= createGitClient());
  let stateStore: StateStore | null = deps.state ?? null;
  const state = () => (stateStore ??= createStateStore());
  try {
    switch (op) {
      case "sessions": {
        const sessions = await client.listSessions();
        return { ok: true, data: { sessions, zellij: client.zellijPath } };
      }
      case "list": {
        const { session } = await client.resolveSession(
          typeof args.session === "string" ? args.session : undefined,
        );
        const view = verbose ? paneViewFull : paneViewSlim;
        const panes = (await client.listPanes(session))
          .filter((p) => !p.isPlugin)
          .map(view)
          .sort((a, b) => a.id.localeCompare(b.id));
        const data: Record<string, unknown> = { session, panes };
        if (verbose && client.selfPaneId) data.self = client.selfPaneId;
        return { ok: true, data };
      }
      case "send": {
        const body = String(args.body ?? args.text ?? "");
        if (!body.trim()) throw new ZellijError("missing_body", "body required");
        const { session, pane } = await resolveTarget(client, args);
        assertWritable(client, pane, args, "send");
        const result = await deliverTo(client, state(), args, {
          session,
          pane,
          body,
          op: "send",
          at: clock.now(),
        });
        if (!result.ok && result.error) {
          throw new ZellijError(result.error.code, result.error.message);
        }
        const data: Record<string, unknown> = {
          delivery: result.delivery,
          session,
          to: result.to,
          from: (typeof args.from === "string" && args.from.trim()) || "swarm",
        };
        if (verbose) data.pane = paneViewFull(pane);
        return { ok: true, data };
      }
      case "broadcast":
        return await broadcast(client, state(), args, clock);
      case "keys":
      case "interrupt": {
        const { session, pane } = await resolveTarget(client, args);
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
        const { session, pane } = await resolveTarget(client, args);
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
        const target = await resolveTarget(client, args);
        return await tailPane(client, state(), args, target);
      }
      case "wait": {
        const target = await resolveTarget(client, args);
        return await waitForPane(client, target, args, clock);
      }
      case "status":
        return await peerStatus(client, args, clock);
      case "signal":
        return postSignal(state(), args, clock);
      case "signals":
        return listSignals(state());
      case "await":
        return await awaitSignal(state(), args, clock);
      case "log":
        return readDeliveryLog(state(), args);
      case "spawn":
        return await spawnPane(client, args, deps.git);
      case "worktrees":
        return await listPeerWorktrees(git(), client, args);
      case "unworktree":
        return await removePeerWorktree(git(), client, args);
      case "close": {
        const { session, pane } = await resolveTarget(client, args);
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
