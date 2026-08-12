import { ZellijError } from "./zellij.js";

/** Named keys Zellij accepts verbatim, keyed by their lowercase spelling. */
const NAMED_KEYS: Record<string, string> = {
  enter: "Enter",
  return: "Enter",
  esc: "Esc",
  escape: "Esc",
  tab: "Tab",
  backspace: "Backspace",
  bs: "Backspace",
  delete: "Delete",
  del: "Delete",
  insert: "Insert",
  ins: "Insert",
  space: "Space",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pgup: "PageUp",
  pagedown: "PageDown",
  pgdn: "PageDown",
};

const MODIFIERS: Record<string, string> = {
  ctrl: "Ctrl",
  control: "Ctrl",
  c: "Ctrl",
  alt: "Alt",
  meta: "Alt",
  opt: "Alt",
  option: "Alt",
  shift: "Shift",
  super: "Super",
  cmd: "Super",
  win: "Super",
};

/** Emission order; Zellij prints modifiers this way in its own docs. */
const MODIFIER_ORDER = ["Ctrl", "Alt", "Shift", "Super"];

function canonicalKey(raw: string): string {
  const key = raw.trim();
  if (!key) throw new ZellijError("bad_key", "empty key");
  if (key.length === 1) return key;
  const named = NAMED_KEYS[key.toLowerCase()];
  if (named) return named;
  if (/^f([1-9]|1[0-2])$/i.test(key)) return `F${key.slice(1)}`;
  throw new ZellijError(
    "bad_key",
    `unknown key "${raw}"; use a single character, F1-F12, or one of ${Object.values(
      NAMED_KEYS,
    )
      .filter((v, i, a) => a.indexOf(v) === i)
      .join("/")}`,
  );
}

/**
 * Normalize one key spec into Zellij's `send-keys` spelling.
 * Accepts `ctrl+c`, `Ctrl-C`, `^C`, `esc`, `Alt Shift b`, `f1`.
 */
export function normalizeKey(raw: string): string {
  const spec = raw.trim();
  if (!spec) throw new ZellijError("bad_key", "empty key");

  if (/^\^[A-Za-z]$/.test(spec)) {
    return `Ctrl ${spec.slice(1).toLowerCase()}`;
  }

  // Split on `+`, whitespace, or a `-` that separates a known modifier.
  const parts = spec
    .replace(/\b(ctrl|control|alt|meta|opt|option|shift|super|cmd|win)-/gi, "$1 ")
    .split(/[+\s]+/)
    .filter(Boolean);
  if (parts.length === 0) throw new ZellijError("bad_key", "empty key");

  const mods: string[] = [];
  for (let i = 0; i < parts.length - 1; i++) {
    const mod = MODIFIERS[parts[i]!.toLowerCase()];
    if (!mod) {
      throw new ZellijError(
        "bad_key",
        `unknown modifier "${parts[i]}" in "${raw}"`,
      );
    }
    if (!mods.includes(mod)) mods.push(mod);
  }

  const key = canonicalKey(parts[parts.length - 1]!);
  if (mods.length === 0) return key;
  const ordered = MODIFIER_ORDER.filter((m) => mods.includes(m));
  // A lone letter with a modifier is lowercase in Zellij's key syntax.
  const base = key.length === 1 ? key.toLowerCase() : key;
  return `${ordered.join(" ")} ${base}`;
}

/**
 * Normalize a key list. Arrays hold one spec per entry; a string is a single
 * spec unless it is comma separated (`"Esc,Enter"`), since `"Ctrl c"` is one key.
 */
export function normalizeKeys(input: unknown): string[] {
  const specs: string[] = [];
  if (Array.isArray(input)) {
    for (const entry of input) {
      if (typeof entry !== "string") {
        throw new ZellijError("bad_key", "keys entries must be strings");
      }
      specs.push(entry);
    }
  } else if (typeof input === "string") {
    specs.push(...(input.includes(",") ? input.split(",") : [input]));
  } else {
    throw new ZellijError("bad_key", "keys must be a string or string array");
  }

  const keys = specs.map((s) => s.trim()).filter(Boolean).map(normalizeKey);
  if (keys.length === 0) throw new ZellijError("bad_key", "no keys given");
  return keys;
}

/**
 * Split a command line into argv. Arrays pass through; strings honour single
 * and double quotes. Zellij runs the command directly — there is no shell.
 */
export function tokenizeCommand(input: unknown): string[] {
  if (input === undefined || input === null || input === "") return [];
  if (Array.isArray(input)) {
    return input.map((part) => {
      if (typeof part !== "string") {
        throw new ZellijError("bad_command", "command entries must be strings");
      }
      return part;
    });
  }
  if (typeof input !== "string") {
    throw new ZellijError("bad_command", "command must be a string or array");
  }

  const argv: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) argv.push(current);
      current = "";
      started = false;
      continue;
    }
    current += ch;
    started = true;
  }
  if (quote) {
    throw new ZellijError("bad_command", `unbalanced ${quote} in command`);
  }
  if (started) argv.push(current);
  return argv;
}
