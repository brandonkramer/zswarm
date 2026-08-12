import { resolveHarness, type HarnessProfile } from "../harness.js";
import type { ZellijClient } from "../zellij/client.js";
import type { ZellijPane } from "../zellij/panes.js";
import type { Clock, OpsResult } from "./types.js";
import { isTrue, normalizeScreen, numberArg, optionalString } from "./util.js";

/** `running` only appears when sampling is off — busy and idle are indistinguishable then. */
export type PeerState = "busy" | "waiting" | "idle" | "exited" | "running";

/** Pane list already in hand, so status does not re-fetch what the caller has. */
export type StatusSource = {
  session: string;
  panes: ZellijPane[];
  source: "plugin" | "zellij";
  /**
   * Batched screen reader. Returns null when it cannot serve the whole set, and
   * status falls back to one `dump-screen` per pane.
   */
  readScreens?: (paneIds: string[]) => Promise<Map<string, string> | null>;
  /** "Has this moved since you last asked?", answered without a sample gap. */
  readChanged?: (
    paneIds: string[],
  ) => Promise<Map<string, { changed: boolean; first: boolean; screen: string }> | null>;
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

/**
 * True when the trailing window holds a named approval prompt. The profile's
 * waiting patterns run across the window; the legacy last-line QUESTION check
 * stays as the conservative fallback for callers without a profile. Bias is
 * toward false negatives: a hit must be prompt UI we can name, never a bare
 * question mark or "confirm".
 */
function promptHolds(screen: string, profile?: HarnessProfile | null): boolean {
  const lines = trailingLines(screen, PROMPT_WINDOW);
  const patterns = profile?.waiting;
  if (patterns && patterns.length > 0) {
    for (const line of lines) {
      for (const re of patterns) {
        if (re.test(line)) return true;
      }
    }
  }
  return QUESTION.test(lines[lines.length - 1] ?? "");
}

export function classify(input: {
  exited: boolean;
  before: string;
  after: string;
  /** The pane's harness; its waiting patterns name the prompts worth blocking on. */
  profile?: HarnessProfile | null;
}): PeerState {
  if (input.exited) return "exited";
  if (input.before !== input.after) return "busy";
  return promptHolds(input.after, input.profile) ? "waiting" : "idle";
}

/**
 * Sample every pane twice and say who is working, who is stuck on a prompt,
 * and who is free — the routing question `list` cannot answer.
 */
export async function peerStatus(
  client: ZellijClient,
  args: Record<string, unknown>,
  clock: Clock,
  supplied?: StatusSource | null,
): Promise<OpsResult> {
  const session =
    supplied?.session ??
    (
      await client.resolveSession(
        typeof args.session === "string" ? args.session : undefined,
      )
    ).session;
  const panes = supplied?.panes ?? (await client.listPanes(session));
  const source = supplied?.source ?? "zellij";
  const only = optionalString(args.to);
  const targets: ZellijPane[] = only
    ? [client.resolvePane(panes, only)]
    : panes.filter((p) => !p.isPlugin);

  // sampleMs=0 asks for the cheap answer: who is alive, from state the plugin
  // already holds. Below that, two samples too close together read as idle.
  const requested = numberArg(args, "sampleMs", 400, { min: 0, max: 10_000 });
  if (requested === 0) {
    const peers = targets
      .map((pane) => {
        const entry: Record<string, unknown> = {
          id: pane.id,
          title: pane.title,
          state: pane.exited ? "exited" : "running",
        };
        if (isTrue(args.verbose)) {
          entry.command = pane.command ?? null;
          entry.cwd = pane.cwd ?? null;
          entry.tab = pane.tabName ?? null;
        }
        return entry;
      })
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
    // No `free`: without sampling there is no way to tell busy from idle.
    return {
      ok: true,
      data: { session, source, sampled: false, sampleMs: 0, peers },
    };
  }
  const sampleMs = Math.max(50, requested);
  const live = targets.filter((pane) => !pane.exited).map((pane) => pane.id);

  // sinceLast trades the fixed 400ms window for "moved since your last call".
  // The plugin remembers the previous screen, so there is no gap to wait out —
  // but ask twice in quick succession and everything reads idle.
  if (isTrue(args.sinceLast) && supplied?.readChanged) {
    const changed = await supplied.readChanged(live);
    if (changed) {
      const peers = targets
        .map((pane) => {
          const row = changed.get(pane.id);
          const state: PeerState = pane.exited
            ? "exited"
            : row?.changed
              ? "busy"
              : promptHolds(row?.screen ?? "", resolveHarness(pane))
                ? "waiting"
                : "idle";
          const entry: Record<string, unknown> = {
            id: pane.id,
            title: pane.title,
            state,
            lastLine: lastLine(row?.screen ?? "").slice(0, 160),
          };
          // First sight has nothing to compare against, so idle is a guess.
          if (row?.first) entry.first = true;
          return entry;
        })
        .sort((a, b) => String(a.id).localeCompare(String(b.id)));
      return {
        ok: true,
        data: {
          session,
          source,
          sampled: false,
          sinceLast: true,
          peers,
          free: peers.filter((p) => p.state === "idle").map((p) => p.id),
        },
      };
    }
  }

  /**
   * One batched read when the bus can serve it, otherwise a process per pane.
   * Both paths normalize, which is what makes them comparable: the plugin pads
   * lines to the terminal width and `dump-screen` does not.
   */
  const sample = async (): Promise<Map<string, string>> => {
    const batched = supplied?.readScreens
      ? await supplied.readScreens(live)
      : null;
    if (batched) {
      return new Map(
        [...batched].map(([id, text]) => [id, normalizeScreen(text)]),
      );
    }
    const screens = new Map<string, string>();
    for (const id of live) {
      const dumped = await client.dumpPane({ session, paneId: id });
      screens.set(id, normalizeScreen(dumped.text));
    }
    return screens;
  };

  const before = await sample();
  await clock.sleep(sampleMs);
  const afterScreens = await sample();

  const peers = [];
  for (const pane of targets) {
    const first = before.get(pane.id) ?? "";
    const after = pane.exited ? first : (afterScreens.get(pane.id) ?? "");
    const state = classify({
      exited: pane.exited,
      before: first,
      after,
      profile: resolveHarness(pane),
    });
    const entry: Record<string, unknown> = {
      id: pane.id,
      title: pane.title,
      state,
      lastLine: lastLine(after).slice(0, 160),
    };
    if (isTrue(args.verbose)) {
      entry.command = pane.command ?? null;
      entry.cwd = pane.cwd ?? null;
      entry.tab = pane.tabName ?? null;
    }
    peers.push(entry);
  }

  peers.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const free = peers.filter((p) => p.state === "idle").map((p) => p.id);
  return {
    ok: true,
    data: { session, source, sampled: true, sampleMs, peers, free },
  };
}
