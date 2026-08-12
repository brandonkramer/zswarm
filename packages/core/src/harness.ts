export type SubmitStrategy = "auto" | "double-enter";

export type HarnessProfile = {
  /** Stable id: "codex" | "cursor" | "opencode" | "gemini" | "pi" | "unknown" */
  name: string;
  /** What `send` should do when the caller did not pass submit= explicitly. */
  submit: SubmitStrategy;
  /**
   * Approval-prompt UI this harness pins on screen. `status` matches these
   * against the trailing lines; a hit means the pane wants input, not time.
   */
  waiting: readonly RegExp[];
};

type HarnessName = Exclude<HarnessProfile["name"], "unknown">;

/** Command and title needles observed on real panes in one live session. */
const PROFILES: ReadonlyArray<{
  name: HarnessName;
  command: readonly string[];
  title: readonly string[];
}> = [
  { name: "codex", command: ["codex"], title: ["agent-codex"] },
  { name: "cursor", command: ["cursor-agent"], title: ["agent-cursor"] },
  { name: "opencode", command: ["opencode"], title: ["agent-opencode"] },
  { name: "gemini", command: ["agy", "gemini"], title: ["agent-gemini"] },
  { name: "pi", command: ["pi"], title: ["agent-pi"] },
];

/**
 * Only codex needs a second Enter to submit: its composer keeps the pasted
 * message (`› [zswarm from=...]`) until an extra Enter lands — verified live
 * on all five harnesses. The other four submit on the paste itself.
 */
const SUBMIT: Record<HarnessName, SubmitStrategy> = {
  codex: "double-enter",
  cursor: "auto",
  opencode: "auto",
  gemini: "auto",
  pi: "auto",
};

/**
 * Prompt shapes any CLI can show, so every profile carries these as a base.
 * They are named UI, never guesses: nothing here matches on a bare "?", the
 * word "confirm", or a lone "y".
 */
const GENERIC_WAITING: readonly RegExp[] = [
  /\(y\/n\)/i,
  /\[y\/n\]/i,
  /press enter to continue/i,
];

/**
 * Per-harness approval UI observed in this live session. Only gemini and
 * opencode showed full-screen prompts worth naming; codex, cursor, and pi
 * show only the generic shapes so far, and unknown panes get the generic set
 * and nothing else. Mislabelling a working pane as waiting makes a dispatcher
 * type into it, so unobserved prompts stay undetected.
 */
const WAITING: Record<HarnessName, readonly RegExp[]> = {
  codex: GENERIC_WAITING,
  cursor: GENERIC_WAITING,
  opencode: [...GENERIC_WAITING, /Permission required/i, /Allow once/i],
  gemini: [
    ...GENERIC_WAITING,
    /Do you want to proceed\?/i,
    /Accept this file edit\?/i,
  ],
  pi: GENERIC_WAITING,
};

const UNKNOWN: HarnessProfile = {
  name: "unknown",
  submit: "auto",
  waiting: GENERIC_WAITING,
};

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Word-boundary match, never a bare `includes`: a raw `pi` substring appears
 * in plenty of real paths (`pip.exe`, `spike/`, `pipeline`), so it would
 * misidentify nearly every pane. `\b` still finds `pi.cmd`, `agent-pi`, and a
 * bare `pi`, but requires the needle to stand alone.
 */
function hasWord(haystack: string, needle: string): boolean {
  return new RegExp(`\\b${escapeRegExp(needle)}\\b`, "i").test(haystack);
}

function matchCommand(command: string | null | undefined): string | null {
  if (!command) return null;
  for (const profile of PROFILES) {
    for (const needle of profile.command) {
      if (hasWord(command, needle)) return profile.name;
    }
  }
  return null;
}

function matchTitle(title: string | null | undefined): string | null {
  if (!title) return null;
  for (const profile of PROFILES) {
    for (const needle of profile.title) {
      if (hasWord(title, needle)) return profile.name;
    }
  }
  return null;
}

/**
 * Identify the harness from a pane's command and title, case-insensitively.
 * The command is the executable that spawned the pane, so it wins; the title
 * is the fallback for panes launched from a generic shell. Never throws.
 */
export function resolveHarness(pane: {
  command?: string | null;
  title?: string | null;
}): HarnessProfile {
  const name = matchCommand(pane.command) ?? matchTitle(pane.title) ?? "unknown";
  if (name === "unknown") return UNKNOWN;
  return { name, submit: SUBMIT[name], waiting: WAITING[name] };
}
