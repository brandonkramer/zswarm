import { ZellijError } from "../errors.js";
import type { ZellijPane } from "../zellij/panes.js";
import type { OpsResult } from "./types.js";

/** Default dump text budget (characters). Override with max=; max=0 disables. */
export const DEFAULT_DUMP_MAX_CHARS = 8_000;
/** `wait` returns a short tail by default — it is called in loops. */
export const DEFAULT_WAIT_MAX_CHARS = 2_000;

export function fail(err: unknown): OpsResult {
  if (err instanceof ZellijError) {
    return { ok: false, error: { code: err.code, message: err.message } };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false, error: { code: "failed", message } };
}

export function isTrue(value: unknown): boolean {
  return value === true || value === "true";
}

export function isVerbose(args: Record<string, unknown>): boolean {
  return isTrue(args.verbose);
}

export function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function paneViewSlim(p: ZellijPane) {
  return {
    id: p.id,
    title: p.title,
    command: p.command ?? null,
    tab: p.tabName ?? null,
  };
}

/**
 * The event-bus view. Zellij's pane manifest carries no command, so the key is
 * left out rather than reported as null — absent means unknown, not none.
 */
export function paneViewBus(p: ZellijPane) {
  return { id: p.id, title: p.title, tab: p.tabName ?? null };
}

export function paneViewFull(p: ZellijPane) {
  return {
    ...paneViewSlim(p),
    cwd: p.cwd ?? null,
    focused: p.focused,
    exited: p.exited,
    floating: p.floating,
  };
}

/** Truncate dump text; default keeps the tail (recent output). */
export function truncateDumpText(
  text: string,
  maxChars: number,
  keep: "tail" | "head" = "tail",
): { text: string; truncated: boolean; chars: number } {
  const chars = text.length;
  if (maxChars <= 0 || chars <= maxChars) {
    return { text, truncated: false, chars };
  }
  if (keep === "head") {
    return { text: text.slice(0, maxChars), truncated: true, chars };
  }
  return { text: text.slice(chars - maxChars), truncated: true, chars };
}

/** Screen text with trailing blanks removed, so idle detection ignores padding. */
export function normalizeScreen(text: string): string {
  return text
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n")
    .replace(/\n+$/, "");
}

export function numberArg(
  args: Record<string, unknown>,
  key: string,
  fallback: number,
  limits: { min: number; max: number },
): number {
  const raw = args[key];
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new ZellijError("bad_arg", `${key} must be a number`);
  }
  return Math.min(limits.max, Math.max(limits.min, Math.floor(n)));
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new ZellijError("cancelled", "operation cancelled");
  }
}

export function dumpMaxChars(
  args: Record<string, unknown>,
  fallback = DEFAULT_DUMP_MAX_CHARS,
): number {
  if (args.max === undefined || args.max === null || args.max === "") {
    return fallback;
  }
  const n = Number(args.max);
  if (!Number.isFinite(n) || n < 0) {
    throw new ZellijError("bad_max", "max must be a non-negative number");
  }
  return Math.floor(n);
}
