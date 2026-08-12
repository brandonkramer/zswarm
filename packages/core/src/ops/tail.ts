import type { StateStore } from "../state.js";
import type { ZellijClient } from "../zellij/client.js";
import type { ZellijPane } from "../zellij/panes.js";
import type { OpsResult } from "./types.js";
import {
  DEFAULT_DUMP_MAX_CHARS,
  dumpMaxChars,
  isTrue,
  normalizeScreen,
  truncateDumpText,
} from "./util.js";

/**
 * What is new in `cur` given the previously seen screen. The viewport scrolls,
 * so the old bottom shows up as the new top: find the longest suffix of the
 * previous screen that still heads the current one, and return the rest.
 */
export function diffScreens(
  prev: string | null,
  cur: string,
): { text: string; reset: boolean } {
  if (prev === null) return { text: cur, reset: true };
  if (cur === prev) return { text: "", reset: false };
  if (cur.startsWith(prev)) return { text: cur.slice(prev.length), reset: false };

  const prevLines = prev.split("\n");
  const curLines = cur.split("\n");
  for (let skip = 1; skip < prevLines.length; skip++) {
    const overlap = prevLines.slice(skip);
    if (overlap.length > curLines.length) continue;
    if (curLines.slice(0, overlap.length).join("\n") === overlap.join("\n")) {
      return { text: curLines.slice(overlap.length).join("\n"), reset: false };
    }
  }
  // Nothing lines up — the pane redrew itself.
  return { text: cur, reset: true };
}

export function cursorKey(session: string, paneId: string): string {
  return `${session}:${paneId}`;
}

/** Read only what a pane printed since the last tail. */
export async function tailPane(
  client: ZellijClient,
  state: StateStore,
  args: Record<string, unknown>,
  target: { session: string; pane: ZellijPane },
): Promise<OpsResult> {
  const { session, pane } = target;
  const key = cursorKey(session, pane.id);
  if (isTrue(args.reset)) state.clearCursor(key);

  const dumped = await client.dumpPane({
    session,
    paneId: pane.id,
    full: isTrue(args.full),
  });
  const screen = normalizeScreen(dumped.text);
  const previous = state.readCursor(key);
  const diff = diffScreens(previous, screen);
  state.writeCursor(key, screen);

  const max = dumpMaxChars(args, DEFAULT_DUMP_MAX_CHARS);
  const clipped = truncateDumpText(diff.text, max);
  return {
    ok: true,
    data: {
      session,
      to: pane.id,
      text: clipped.text,
      reset: diff.reset,
      fresh: diff.text.length > 0,
      truncated: clipped.truncated,
      chars: clipped.chars,
    },
  };
}
