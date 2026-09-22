import { ZellijError } from "../errors.js";
import { resolveHarness, type HarnessProfile } from "../harness.js";
import type { ZellijClient } from "../zellij/client.js";
import type { ZellijPane } from "../zellij/panes.js";
import type { Clock, OpsResult } from "./types.js";
import {
  isTrue,
  normalizeScreen,
  numberArg,
  optionalString,
  throwIfAborted,
} from "./util.js";

/** `running` only appears when sampling is off — busy and idle are indistinguishable then. */
export type PeerState =
  | "busy"
  | "waiting"
  | "idle"
  | "exited"
  | "running"
  | "unknown";

/** Pane list already in hand, so status does not re-fetch what the caller has. */
export type StatusSource = {
  session: string;
  panes: ZellijPane[];
  source: "plugin" | "zellij";
  /**
   * Batched screen reader. Returns null when it cannot serve the whole set, and
   * status falls back to one `dump-screen` per pane.
   * `timeoutMs` is the remaining overall status budget.
   */
  readScreens?: (
    paneIds: string[],
    timeoutMs: number,
  ) => Promise<Map<string, string> | null>;
  /** "Has this moved since you last asked?", answered without a sample gap. */
  readChanged?: (
    paneIds: string[],
    timeoutMs: number,
  ) => Promise<Map<
    string,
    { changed: boolean; first: boolean; screen: string }
  > | null>;
};

/**
 * Legacy last-line prompt shapes for callers without a profile. A term counts
 * only when it is a question, not chrome: a y/n form, a trailing `?`, or the
 * canonical "press enter to continue" pause. A bare "confirm" or "continue"
 * sits in status bars ("select  enter confirm") and must not qualify.
 */
const QUESTION =
  /(\(y\/n\)|\[y\/n\]|\(yes\/no\)|\[y\/n\/a\]|password:|passphrase:|(?:continue|proceed|overwrite|confirm)\?|press\s+enter\s+to\s+continue)/i;

/**
 * How many trailing non-empty lines `status` inspects for a named prompt. A
 * full-screen TUI hides its prompt under chrome, so the last line alone is
 * the wrong place to look — measured live, gemini's question sat 4 lines
 * above "esc to cancel", and a six-option permission menu with wrapped
 * lines put it 12 lines up. 24 clears the measured 12 with headroom for
 * wider menus. Widening is safe for the named patterns because they are
 * specific strings; the legacy last-line QUESTION fallback stays exactly
 * where it is or it would fire on chrome.
 */
const PROMPT_WINDOW = 24;

/** Default overall budget for a sampled status pass (covers IPC + dumps). */
export const DEFAULT_STATUS_TIMEOUT_MS = 30_000;

/** How many dump-screen calls to run at once on the direct (non-bus) path. */
export const STATUS_DUMP_CONCURRENCY = 3;

export function lastLine(screen: string): string {
  const lines = screen.split("\n").filter((l) => l.trim());
  return lines.length > 0 ? lines[lines.length - 1]!.trim() : "";
}

function trailingLines(screen: string, n: number): string[] {
  return screen
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-n);
}

export type WaitingEvidence = { reason: "approval_menu" | "prompt"; evidence: string; source: "screen" };

export function waitingPrompt(screen: string, profile?: HarnessProfile | null): WaitingEvidence | null {
  const lines = trailingLines(screen, PROMPT_WINDOW);
  // A menu requires a choice structure AND navigation chrome. A lone "Allow
  // once" in logs/help must not turn a worker into an approval request.
  const choices = lines.filter((line) => /^(?:[›❯>●]\s*)?\d+[.)]\s+(?:Yes\b|No\b|Allow\b|Deny\b|Cancel\b)/i.test(line));
  const navigation = lines.some((line) => /(?:enter|return)\s+(?:to\s+)?(?:select|confirm)|(?:esc|escape)\s+(?:to\s+)?cancel/i.test(line));
  const approval = lines.find((line) => /^(?:[›❯>]\s*)?(?:Approve (?:this|the) (?:operation|command|action)|Approval required|Would you like to run the following command\?|Run this command\?)[?:]?$/i.test(line));
  if (approval && choices.length >= 2 && navigation) {
    return { reason: "approval_menu", evidence: choices.slice(0, 3).join("\n").slice(0, 320), source: "screen" };
  }
  for (const line of lines) {
    if (profile?.waiting.some((re) => re.test(line))) {
      return { reason: "prompt", evidence: line.slice(0, 320), source: "screen" };
    }
  }
  const last = lines[lines.length - 1] ?? "";
  return QUESTION.test(last) ? { reason: "prompt", evidence: last.slice(0, 320), source: "screen" } : null;
}

function promptHolds(screen: string, profile?: HarnessProfile | null): boolean {
  return waitingPrompt(screen, profile) !== null;
}

/** Compact summary of the selected terminal peers, including inactive tabs. */
export function statusTabs(peers: Record<string, unknown>[]) {
  const tabs = new Map<string, { id: unknown; name: unknown; panes: number; states: Record<string, number> }>();
  for (const peer of peers) {
    const key = JSON.stringify([peer.tabId, peer.tab]);
    const tab = tabs.get(key) ?? { id: peer.tabId, name: peer.tab, panes: 0, states: {} };
    tab.panes++;
    const state = String(peer.state);
    tab.states[state] = (tab.states[state] ?? 0) + 1;
    tabs.set(key, tab);
  }
  return [...tabs.values()];
}

export function classify(input: {
  exited: boolean;
  before: string;
  after: string;
  profile?: HarnessProfile | null;
}): PeerState {
  if (input.exited) return "exited";
  if (input.before !== input.after) return "busy";
  return promptHolds(input.after, input.profile) ? "waiting" : "idle";
}

/** Run `fn` over items with at most `limit` in flight. */
export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const concurrency = Math.max(1, Math.min(limit, items.length));
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!, i);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

function isCancelledError(err: unknown): boolean {
  return (
    (err instanceof ZellijError && err.code === "cancelled") ||
    (err instanceof Error && /cancelled/i.test(err.message))
  );
}

function peerEntry(
  pane: ZellijPane,
  state: PeerState,
  screen: string,
  verbose: boolean,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    id: pane.id,
    title: pane.title,
    tab: pane.tabName ?? null,
    tabId: pane.tabId ?? null,
    state,
    lastLine: lastLine(screen).slice(0, 160),
    ...extra,
  };
  if (state === "waiting") entry.waiting = waitingPrompt(screen, resolveHarness(pane));
  if (verbose) {
    entry.command = pane.command ?? null;
    entry.cwd = pane.cwd ?? null;
  }
  return entry;
}

/**
 * Sample every pane twice and say who is working, who is stuck on a prompt,
 * and who is free — the routing question `list` cannot answer.
 *
 * `deadlineAt` is the absolute clock deadline for the whole status op (setup
 * included). When omitted, one is derived from `timeoutMs` at entry.
 */
export async function peerStatus(
  client: ZellijClient,
  args: Record<string, unknown>,
  clock: Clock,
  supplied?: StatusSource | null,
  opts: { deadlineAt?: number; signal?: AbortSignal } = {},
): Promise<OpsResult> {
  const signal = opts.signal;
  throwIfAborted(signal);

  const budget = numberArg(args, "timeoutMs", DEFAULT_STATUS_TIMEOUT_MS, {
    min: 1_000,
    max: 900_000,
  });
  const deadline = opts.deadlineAt ?? clock.now() + budget;
  const remaining = (): number => Math.max(0, deadline - clock.now());
  const setupBudget = (): number => {
    throwIfAborted(signal);
    const left = remaining();
    if (left <= 0) {
      throw new ZellijError("zellij_failed", "status timed out during setup");
    }
    return left;
  };

  // Prefer the caller's already-resolved session/panes so dispatch's setup
  // budget is not spent twice.
  const session =
    supplied?.session ??
    (
      await client.resolveSession(
        typeof args.session === "string" ? args.session : undefined,
        setupBudget(),
      )
    ).session;
  throwIfAborted(signal);
  const panes =
    supplied?.panes ?? (await client.listPanes(session, setupBudget()));
  throwIfAborted(signal);
  const source = supplied?.source ?? "zellij";
  const only = optionalString(args.to);
  const verbose = isTrue(args.verbose);
  const targets: ZellijPane[] = only
    ? [client.resolvePane(panes, only)]
    : panes.filter((p) => !p.isPlugin);

  const requested = numberArg(args, "sampleMs", 400, { min: 0, max: 10_000 });
  if (requested === 0) {
    const peers = targets
      .map((pane) =>
        peerEntry(pane, pane.exited ? "exited" : "running", "", verbose),
      )
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
    return {
      ok: true,
      data: { session, source, sampled: false, sampleMs: 0, peers, tabs: statusTabs(peers) },
    };
  }
  const sampleMs = Math.max(50, requested);
  const live = targets.filter((pane) => !pane.exited);

  // Explicit sampling retains its interval semantics. Ordinary status prefers
  // one bus observation, including a single-pane crew, with no sample sleep.
  const preferChanges = isTrue(args.sinceLast) || (args.sinceLast === undefined && args.sampleMs === undefined);
  if (preferChanges && supplied?.readChanged) {
    const left = remaining();
    let changed: Awaited<ReturnType<NonNullable<StatusSource["readChanged"]>>> = null;
    try {
      changed = live.length === 0 ? new Map() : left > 0 ? await supplied.readChanged(live.map((p) => p.id), left) : null;
    } catch (err) {
      if (isCancelledError(err) || signal?.aborted) throw new ZellijError("cancelled", "operation cancelled");
      // A missing/older bus falls back to bounded screen samples below.
    }
    throwIfAborted(signal);
    if (changed) {
      const peers = targets
        .map((pane) => {
          if (pane.exited) {
            return peerEntry(pane, "exited", "", verbose);
          }
          const row = changed.get(pane.id);
          const state: PeerState = !row ? "unknown"
            : promptHolds(row.screen, resolveHarness(pane)) ? "waiting"
            : row.first ? "unknown" : row.changed ? "busy" : "idle";
          return peerEntry(pane, state, row?.screen ?? "", verbose, {
            ...(row?.first ? { first: true } : {}),
          });
        })
        .sort((a, b) => String(a.id).localeCompare(String(b.id)));
      return {
        ok: true,
        data: {
          session,
          source,
          sampled: false,
          sinceLast: true,
          observation: "bus-changes",
          peers,
          tabs: statusTabs(peers),
          free: peers.filter((p) => p.state === "idle").map((p) => p.id),
        },
      };
    }
  }

  type SamplePair = { before: string | null; after: string | null };

  /**
   * Bus path: one batched read per round, each bounded by the remaining budget.
   * Direct path: each pane completes its own before→sleep→after pair under a
   * shared concurrency limit so one stall does not block healthy peers.
   */
  const samples = new Map<string, SamplePair>();

  if (supplied?.readScreens) {
    const sampleRound = async (): Promise<Map<string, string | null>> => {
      throwIfAborted(signal);
      const left = remaining();
      if (left <= 0) {
        return new Map(live.map((p) => [p.id, null]));
      }
      try {
        const batched = await supplied.readScreens!(
          live.map((p) => p.id),
          left,
        );
        throwIfAborted(signal);
        if (!batched) return new Map(); // signal fallback to dumps below
        return new Map(
          live.map((p) => {
            const text = batched.get(p.id);
            return [
              p.id,
              text === undefined ? null : normalizeScreen(text),
            ] as const;
          }),
        );
      } catch (err) {
        if (isCancelledError(err) || signal?.aborted) {
          throw new ZellijError("cancelled", "operation cancelled");
        }
        return new Map(live.map((p) => [p.id, null]));
      }
    };

    let before = await sampleRound();
    if (before.size === 0) {
      // Bus declined — fall through to per-pane dumps.
      before = new Map();
    } else {
      let after = new Map<string, string | null>();
      if (remaining() > sampleMs) {
        await clock.sleep(sampleMs);
        throwIfAborted(signal);
        after = await sampleRound();
      }
      for (const pane of live) {
        samples.set(pane.id, {
          before: before.get(pane.id) ?? null,
          after: after.get(pane.id) ?? null,
        });
      }
    }
  }

  if (samples.size === 0) {
    // Per-pane sample pairs under bounded concurrency.
    await mapPool(live, STATUS_DUMP_CONCURRENCY, async (pane) => {
      throwIfAborted(signal);
      const dumpOne = async (): Promise<string | null> => {
        const left = remaining();
        if (left <= 0) return null;
        try {
          const dumped = await client.dumpPane({
            session,
            paneId: pane.id,
            timeoutMs: left,
          });
          throwIfAborted(signal);
          return normalizeScreen(dumped.text);
        } catch (err) {
          if (isCancelledError(err) || signal?.aborted) {
            throw new ZellijError("cancelled", "operation cancelled");
          }
          return null;
        }
      };
      const before = await dumpOne();
      throwIfAborted(signal);
      let after: string | null = null;
      // This pane's interval starts when its first screen is available. Queue
      // time and a slow first read cannot replace time between observations.
      // Without room for the whole interval, keep it unknown rather than idle.
      if (before !== null && remaining() > sampleMs) {
        await clock.sleep(sampleMs);
        throwIfAborted(signal);
        after = await dumpOne();
      }
      samples.set(pane.id, { before, after });
    });
  }

  throwIfAborted(signal);

  const peers = [];
  let partial = false;
  for (const pane of targets) {
    if (pane.exited) {
      peers.push(peerEntry(pane, "exited", "", verbose));
      continue;
    }
    const pair = samples.get(pane.id);
    const first = pair?.before ?? null;
    const after = pair?.after ?? null;
    if (first == null || after == null) {
      partial = true;
      peers.push(
        peerEntry(pane, "unknown", after ?? first ?? "", verbose),
      );
      continue;
    }
    const state = classify({
      exited: false,
      before: first,
      after,
      profile: resolveHarness(pane),
    });
    peers.push(peerEntry(pane, state, after, verbose));
  }

  peers.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const free = peers.filter((p) => p.state === "idle").map((p) => p.id);
  const data: Record<string, unknown> = {
    session,
    source,
    sampled: true,
    observation: "samples",
    sampleMs,
    peers,
    tabs: statusTabs(peers),
    free,
  };
  if (partial || remaining() <= 0) data.partial = true;
  return { ok: true, data };
}
