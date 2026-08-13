import { existsSync } from "node:fs";
import { ZellijError } from "../errors.js";
import type { Policy } from "../policy.js";
import type { StateStore } from "../state.js";
import {
  DEFAULT_BUS_KEY,
  busPluginUrl,
  nextConfigKey,
  parseBusReply,
  parseChangedReply,
  parseScrollbackReply,
  parseWaitReply,
  resolveBusPlugin,
  scrollbackToScreen,
  type BusChanged,
  type BusSnapshot,
  type BusWait,
} from "../zellij/bus.js";
import type { WaitRequest } from "../zellij/args.js";
import type { ZellijClient } from "../zellij/client.js";
import type { Clock, OpsResult } from "./types.js";
import { isTrue } from "./util.js";

/**
 * Whether to ask the event-bus plugin, and what to do when it does not answer.
 *
 * The bus is off until `bus --install` has walked the plugin's permission
 * prompt, because a pipe to a plugin that was never approved costs a process
 * and a timeout on every call and then falls back anyway.
 */

/** Config keys to try before giving up; each one is a fresh pipe destination. */
const MAX_KEY_ATTEMPTS = 3;
/** A just-launched instance answers before Zellij has pushed it anything. */
const COLD_RETRY_MS = 200;

export type BusPlan = {
  enabled: boolean;
  /** Why the bus is off, or how it was turned on. */
  reason: string;
  plugin: string | null;
  url: string | null;
  configKey: string;
  installed: boolean;
};

/** Set once a pipe has failed, so one dead plugin costs one timeout, not many. */
let processDisabled: string | null = null;
/** The key that actually answered, per session, for the life of this process. */
const answeredWith = new Map<string, string>();

/** Tests share a module instance; this drops what a previous case cached. */
export function resetBusCache(): void {
  processDisabled = null;
  answeredWith.clear();
}

function affirmative(raw: string | undefined): boolean {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function negative(raw: string | undefined): boolean {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "0" || v === "false" || v === "no" || v === "off";
}

export function planBus(
  client: ZellijClient,
  state: StateStore,
  env: NodeJS.ProcessEnv = process.env,
): BusPlan {
  const marker = state.readBus();
  // A marker can outlive the wasm it names — an upgrade renames the artifact,
  // so a remembered path that no longer exists must not shadow the current one.
  const remembered = marker && existsSync(marker.plugin) ? marker : null;
  const plugin = remembered?.plugin ?? resolveBusPlugin(env);
  const configKey = remembered?.configKey ?? DEFAULT_BUS_KEY;
  const base: BusPlan = {
    enabled: false,
    reason: "",
    plugin,
    url: plugin ? busPluginUrl(plugin) : null,
    configKey,
    installed: marker !== null,
  };

  if (negative(env.ZSWARM_BUS)) return { ...base, reason: "ZSWARM_BUS=0" };
  if (client.remote) {
    return { ...base, reason: "remote session: a file: plugin url is local-only" };
  }
  if (!plugin) {
    return {
      ...base,
      reason: "no plugin wasm found; run pnpm build:plugin or set ZSWARM_BUS_PLUGIN",
    };
  }
  if (processDisabled) return { ...base, reason: processDisabled };
  if (affirmative(env.ZSWARM_BUS)) {
    return { ...base, enabled: true, reason: "ZSWARM_BUS=1" };
  }
  if (marker) return { ...base, enabled: true, reason: "installed" };
  return { ...base, reason: 'not installed; run zswarm({op:"bus", install:true})' };
}

async function askOnce(
  client: ZellijClient,
  session: string,
  url: string,
  configKey: string,
  payload: string,
): Promise<BusSnapshot | null> {
  const result = await client.pipePlugin({ session, url, configKey, payload });
  return parseBusReply(result.stdout);
}

/**
 * Zellij pushes a pane manifest on change, never on subscribe — there is no
 * get_pane_manifest(). A quiet session leaves a freshly launched instance
 * blind (ready:false, paneUpdates:0) until something moves. Renaming a pane
 * to the title it already has is an invisible change that forces the push.
 */
async function nudgeManifest(
  client: ZellijClient,
  session: string,
): Promise<void> {
  const panes = await client.listPanes(session);
  const pane = panes.find((p) => !p.isPlugin && !p.exited && p.title.trim());
  if (!pane) return;
  await client.renamePane({ session, paneId: pane.id, name: pane.title });
}

/**
 * One pipe, one answer — or null, and the caller polls instead.
 *
 * Two things go wrong in practice. A stale instance under the same key eats the
 * message and replies with nothing, so each attempt rotates to a new key. And a
 * freshly launched instance replies before Zellij has pushed it a manifest, so
 * a not-ready answer is retried once rather than reported as an empty session.
 * If it is still cold after that, one same-title rename nudges Zellij to push.
 */
export async function busSnapshot(
  client: ZellijClient,
  state: StateStore,
  session: string,
  clock: Clock,
  env: NodeJS.ProcessEnv = process.env,
  payload = "status",
): Promise<{ snapshot: BusSnapshot; configKey: string } | null> {
  const plan = planBus(client, state, env);
  const pluginPath = plan.plugin;
  if (!plan.enabled || !plan.url || !pluginPath) return null;

  let configKey = answeredWith.get(session) ?? plan.configKey;
  let nudged = false;
  for (let attempt = 0; attempt < MAX_KEY_ATTEMPTS; attempt++) {
    let snapshot = await askOnce(client, session, plan.url, configKey, payload);
    if (snapshot && !snapshot.ready) {
      await clock.sleep(COLD_RETRY_MS);
      snapshot =
        (await askOnce(client, session, plan.url, configKey, payload)) ??
        snapshot;
    }
    if (snapshot && !snapshot.ready && !nudged) {
      nudged = true;
      try {
        await nudgeManifest(client, session);
        snapshot =
          (await askOnce(client, session, plan.url, configKey, payload)) ??
          snapshot;
      } catch {
        // A failed nudge must not fail the op — the caller polls instead.
      }
    }
    if (snapshot) {
      answeredWith.set(session, configKey);
      if (plan.installed && configKey !== plan.configKey) {
        // Remember the rotation, so the next process starts on a live key.
        state.writeBus({
          plugin: pluginPath,
          configKey,
          installedAt: clock.now(),
        });
      }
      return { snapshot, configKey };
    }
    configKey = nextConfigKey(configKey);
  }

  processDisabled = "plugin did not answer; using zellij polling for this run";
  return null;
}

/**
 * Read several pane screens in one pipe, or null to make the caller poll.
 *
 * Measured on this tree: the pipe costs ~0.055s fixed plus ~0.014s per pane,
 * `dump-screen` ~0.050s per pane. So this is a loss for one pane and a win from
 * two upward — callers must not route single-pane reads here.
 *
 * The text comes back as viewport lines padded to the terminal width, where
 * `dump-screen` returns them ragged. `normalizeScreen` erases exactly that
 * difference, and every caller here already normalizes before comparing.
 */
export async function busScreens(
  client: ZellijClient,
  state: StateStore,
  session: string,
  paneIds: string[],
  clock: Clock,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Map<string, string> | null> {
  if (paneIds.length < 2) return null;
  const plan = planBus(client, state, env);
  if (!plan.enabled || !plan.url) return null;
  const configKey = answeredWith.get(session) ?? plan.configKey;
  const reply = await client.scrollbackPlugin({
    session,
    url: plan.url,
    configKey,
    panes: paneIds,
  });
  const parsed = parseScrollbackReply(reply.stdout);
  if (!parsed || !parsed.ready) return null;
  const screens = new Map<string, string>();
  for (const pane of parsed.panes) {
    screens.set(pane.id, scrollbackToScreen(pane));
  }
  // A pane that vanished mid-read is normal; a wholesale miss is not, and
  // silently returning fewer screens would read as "those panes are quiet".
  return screens.size === paneIds.length ? screens : null;
}

/**
 * Hand the whole wait to the plugin, which holds the pipe until it resolves.
 * One process covers a minute-long wait instead of one per poll, and the plugin
 * can poll far tighter than a process spawn allows.
 *
 * Returns null for anything it will not serve — a regex needle, a cold
 * instance, no reply — and the caller runs its own loop.
 */
export async function busWait(
  client: ZellijClient,
  state: StateStore,
  session: string,
  request: WaitRequest,
  env: NodeJS.ProcessEnv = process.env,
): Promise<BusWait | null> {
  const plan = planBus(client, state, env);
  if (!plan.enabled || !plan.url) return null;
  const configKey = answeredWith.get(session) ?? plan.configKey;
  const reply = await client.waitPlugin({
    session,
    url: plan.url,
    configKey,
    ...request,
  });
  const parsed = parseWaitReply(reply.stdout);
  // `gone` means the pane vanished mid-wait; the polling path reports that
  // with its own error, so let it.
  return parsed && parsed.reason !== "gone" ? parsed : null;
}

/**
 * Screens plus "did this move since you last asked". Answers the same question
 * `status` answers by sampling twice, without the gap between samples — but
 * relative to the previous call rather than a fixed window.
 */
export async function busChanged(
  client: ZellijClient,
  state: StateStore,
  session: string,
  paneIds: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<BusChanged | null> {
  if (paneIds.length === 0) return null;
  const plan = planBus(client, state, env);
  if (!plan.enabled || !plan.url) return null;
  const configKey = answeredWith.get(session) ?? plan.configKey;
  const reply = await client.changedPlugin({
    session,
    url: plan.url,
    configKey,
    panes: paneIds,
  });
  const parsed = parseChangedReply(reply.stdout);
  if (!parsed || !parsed.ready) return null;
  return parsed.panes.length === paneIds.length ? parsed : null;
}

/** Report on the bus, install it, or forget it. */
export async function busOp(
  client: ZellijClient,
  state: StateStore,
  args: Record<string, unknown>,
  clock: Clock,
  env: NodeJS.ProcessEnv = process.env,
  policy?: Policy,
): Promise<OpsResult> {
  if (isTrue(args.clear)) {
    state.clearBus();
    resetBusCache();
    return { ok: true, data: { installed: false, cleared: true } };
  }

  const { session } = await client.resolveSession(
    typeof args.session === "string" ? args.session : undefined,
  );

  if (isTrue(args.install)) {
    // Installing opens a pane, which a read-only crew is not allowed to do.
    if (policy?.readOnly) {
      throw new ZellijError(
        "policy_denied",
        'op "bus" with install opens a pane; denied by ZSWARM_READONLY',
      );
    }
    const plugin = resolveBusPlugin(env);
    if (!plugin) {
      throw new ZellijError(
        "bus_missing",
        "no plugin wasm found; run pnpm build:plugin or set ZSWARM_BUS_PLUGIN",
      );
    }
    const previous = state.readBus();
    const force = isTrue(args.force);
    // Launching again would add a second instance, so an install that is
    // already answering is a no-op unless the caller asked for a fresh one.
    if (previous && !force) {
      const live = await busSnapshot(client, state, session, clock, env);
      if (live?.snapshot.ready) {
        return {
          ok: true,
          data: {
            session,
            installed: true,
            plugin: previous.plugin,
            url: busPluginUrl(previous.plugin),
            configKey: live.configKey,
            ready: true,
            panes: live.snapshot.panes.length,
            note: "already installed; --force reloads under a fresh key",
          },
        };
      }
    }
    // A reload needs a key Zellij has not already bound an instance to.
    const configKey =
      force && previous
        ? nextConfigKey(previous.configKey)
        : (previous?.configKey ?? DEFAULT_BUS_KEY);
    const url = busPluginUrl(plugin);
    const launched = await client.launchPlugin({
      session,
      url,
      configKey,
      floating: true,
      skipCache: force,
    });
    state.writeBus({ plugin, configKey, installedAt: clock.now() });
    resetBusCache();
    const probe = await busSnapshot(client, state, session, clock, env);
    return {
      ok: true,
      data: {
        session,
        installed: true,
        plugin,
        url,
        configKey,
        pane: launched.paneId,
        ready: probe?.snapshot.ready ?? false,
        panes: probe?.snapshot.panes.length ?? null,
        note: probe
          ? "bus answering; list and status use it now, and this pane can be closed"
          : "approve the plugin's permission prompt in the new pane, then re-run",
      },
    };
  }

  const plan = planBus(client, state, env);
  const probe = plan.enabled
    ? await busSnapshot(client, state, session, clock, env)
    : null;
  return {
    ok: true,
    data: {
      session,
      enabled: plan.enabled,
      reason: plan.reason,
      installed: plan.installed,
      plugin: plan.plugin,
      url: plan.url,
      configKey: probe?.configKey ?? plan.configKey,
      ready: probe?.snapshot.ready ?? false,
      paneUpdates: probe?.snapshot.paneUpdates ?? null,
      tabUpdates: probe?.snapshot.tabUpdates ?? null,
      panes: probe?.snapshot.panes.length ?? null,
    },
  };
}
