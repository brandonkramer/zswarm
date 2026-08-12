export type SubmitStrategy = "auto" | "double-enter";

export type HarnessProfile = {
  /** Stable id: "codex" | "cursor" | "opencode" | "gemini" | "pi" | "unknown" */
  name: string;
  /** What `send` should do when the caller did not pass submit= explicitly. */
  submit: SubmitStrategy;
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

const UNKNOWN: HarnessProfile = { name: "unknown", submit: "auto" };

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
  return { name, submit: SUBMIT[name] };
}
