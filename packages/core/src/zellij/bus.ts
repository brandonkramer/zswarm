import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expandHomePath } from "./binary.js";
import type { ZellijPane } from "./panes.js";

/**
 * The event-bus side of zswarm: Zellij pushes pane and tab state into a WASM
 * plugin as it changes, and one CLI pipe reads it back out of memory. Parsing
 * and path resolution live here; the process calls live in the client, and the
 * fallback policy lives in `ops/bus.ts`.
 */

export const BUS_PIPE_NAME = "zswarm";
export const DEFAULT_BUS_KEY = "zswarm-bus";
/** A stalled instance answers nothing, so the pipe must not inherit the long timeout. */
export const DEFAULT_BUS_TIMEOUT_MS = 2_500;

/** Where a published zswarm keeps the compiled plugin, relative to the tree root. */
const PREBUILT_RELATIVE = join("plugin", "prebuilt", "zswarm-bus.wasm");

export type BusPane = {
  id: string;
  title: string;
  exited: boolean;
  focused: boolean;
  command: string | null;
  tab: number;
};

export type BusSnapshot = {
  /** False until Zellij has pushed a manifest — a cold instance, not an empty session. */
  ready: boolean;
  paneUpdates: number;
  tabUpdates: number;
  tabs: string[];
  panes: BusPane[];
};

export type BusMarker = {
  plugin: string;
  configKey: string;
  installedAt: number;
};

/** Absolute path of the plugin wasm, or null when there is nothing to load. */
export function resolveBusPlugin(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const explicit = expandHomePath(
    (env.ZSWARM_BUS_PLUGIN ?? "").trim().replace(/^['"]|['"]$/g, ""),
    env,
  );
  if (explicit) return existsSync(explicit) ? resolve(explicit) : null;

  // Walk up from this module so the same lookup works from src/, dist/, and
  // from inside node_modules once the package is published.
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth++) {
    const candidate = join(dir, PREBUILT_RELATIVE);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Zellij wants a `file:` url with forward slashes, including on Windows. */
export function busPluginUrl(pluginPath: string): string {
  return `file:${resolve(pluginPath).replace(/\\/g, "/")}`;
}

/** zswarm-bus → zswarm-bus-2 → zswarm-bus-3: a fresh pipe destination each time. */
export function nextConfigKey(key: string): string {
  const match = /^(.*)-(\d+)$/.exec(key);
  if (!match) return `${key}-2`;
  return `${match[1]}-${Number(match[2]) + 1}`;
}

function toSnapshot(value: Record<string, unknown>): BusSnapshot | null {
  if (value.ok !== true || !Array.isArray(value.panes)) return null;
  const panes: BusPane[] = [];
  for (const row of value.panes) {
    if (!row || typeof row !== "object") continue;
    const p = row as Record<string, unknown>;
    if (typeof p.id !== "string") continue;
    panes.push({
      id: p.id,
      title: typeof p.title === "string" ? p.title : "",
      exited: p.exited === true,
      focused: p.focused === true,
      command: typeof p.command === "string" ? p.command : null,
      tab: typeof p.tab === "number" ? p.tab : 0,
    });
  }
  return {
    ready: value.ready === true,
    paneUpdates: typeof value.paneUpdates === "number" ? value.paneUpdates : 0,
    tabUpdates: typeof value.tabUpdates === "number" ? value.tabUpdates : 0,
    tabs: Array.isArray(value.tabs)
      ? value.tabs.filter((t): t is string => typeof t === "string")
      : [],
    panes,
  };
}

/**
 * Pull the plugin's answer out of the pipe. Zellij interleaves its own notices
 * ("Action CliPipe did not complete within 1s timeout" shows up on successful
 * runs too), so scan for the first line that is our JSON rather than parsing
 * the whole of stdout.
 */
export function parseBusReply(stdout: string): BusSnapshot | null {
  for (const line of stdout.split("\n")) {
    const text = line.trim();
    if (!text.startsWith("{")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    if (parsed && typeof parsed === "object") {
      const snapshot = toSnapshot(parsed as Record<string, unknown>);
      if (snapshot) return snapshot;
    }
  }
  return null;
}

/**
 * Shape the snapshot like `list-panes` output. `cwd` and `floating` are not in
 * the manifest Zellij pushes, so they read as unknown here — callers that need
 * them (anything verbose) must take the polling path instead.
 */
export function busToPanes(snapshot: BusSnapshot): ZellijPane[] {
  return snapshot.panes.map((pane) => {
    const isPlugin = pane.id.startsWith("plugin_");
    const numeric = Number(pane.id.slice(pane.id.indexOf("_") + 1));
    return {
      id: pane.id,
      numericId: Number.isFinite(numeric) ? numeric : -1,
      isPlugin,
      title: pane.title,
      command: pane.command,
      cwd: null,
      tabName: snapshot.tabs[pane.tab] ?? null,
      tabId: pane.tab,
      focused: pane.focused,
      exited: pane.exited,
      floating: false,
    };
  });
}
