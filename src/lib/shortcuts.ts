/**
 * Keyboard shortcut helpers.
 *
 * Shortcuts are written as lowercase `+`-joined strings, e.g. `mod+k`,
 * `mod+shift+n`, `mod+1`, `mod+/`. `mod` means ⌘ on macOS and Ctrl
 * elsewhere. The same string drives matching (global key handler), display
 * (`formatShortcut`, `<Kbd>`) and the shortcuts overlay.
 */

/** A shortcut split into its modifiers and main key. */
export interface ParsedShortcut {
  mod: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  /** Lowercased main key, e.g. `k`, `1`, `/`, `enter`, `arrowup`. */
  key: string;
}

/** The subset of `KeyboardEvent` we need (keeps helpers testable). */
export interface KeyLike {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** Whether the current platform uses ⌘ as the primary modifier. */
export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return true;
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform ??
    "";
  return /mac|iphone|ipad/i.test(platform) || /Mac OS X/.test(navigator.userAgent);
}

/** Parse `mod+shift+n` into its parts. Throws on an empty key. */
export function parseShortcut(shortcut: string): ParsedShortcut {
  const parts = shortcut
    .toLowerCase()
    .split("+")
    .map((p) => p.trim());
  // `mod++` means the plus key itself.
  if (shortcut.endsWith("++")) parts.splice(parts.length - 2, 2, "+");
  const parsed: ParsedShortcut = { mod: false, ctrl: false, alt: false, shift: false, meta: false, key: "" };
  for (const part of parts) {
    if (part === "mod" || part === "cmdorctrl") parsed.mod = true;
    else if (part === "ctrl" || part === "control") parsed.ctrl = true;
    else if (part === "alt" || part === "option" || part === "opt") parsed.alt = true;
    else if (part === "shift") parsed.shift = true;
    else if (part === "meta" || part === "cmd" || part === "command") parsed.meta = true;
    else if (part) parsed.key = part === "esc" ? "escape" : part === "space" ? " " : part;
  }
  if (!parsed.key) throw new Error(`Shortcut "${shortcut}" has no key`);
  return parsed;
}

const CODE_FOR_KEY: Record<string, string> = {
  "/": "Slash",
  "\\": "Backslash",
  ",": "Comma",
  ".": "Period",
  ";": "Semicolon",
  "'": "Quote",
  "[": "BracketLeft",
  "]": "BracketRight",
  "-": "Minus",
  "=": "Equal",
  "`": "Backquote",
  " ": "Space",
};

function codeFor(key: string): string | null {
  if (/^[a-z]$/.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  return CODE_FOR_KEY[key] ?? null;
}

function isSymbolKey(key: string): boolean {
  return key.length === 1 && !/[a-z0-9]/.test(key);
}

/**
 * Does the keyboard event match the shortcut? Matches by `key` first and by
 * physical `code` as a fallback (so ⌥-combos and non-US layouts work). For
 * punctuation keys the Shift state is ignored unless the shortcut names it,
 * because many layouts need Shift to type `/` or `?`.
 */
export function matchesShortcut(event: KeyLike, shortcut: string, mac: boolean = isMacPlatform()): boolean {
  const s = parseShortcut(shortcut);
  const wantMeta = s.meta || (s.mod && mac);
  const wantCtrl = s.ctrl || (s.mod && !mac);
  if (event.metaKey !== wantMeta) return false;
  if (event.ctrlKey !== wantCtrl) return false;
  if (event.altKey !== s.alt) return false;
  const symbol = isSymbolKey(s.key);
  if (!(symbol && !s.shift) && event.shiftKey !== s.shift) return false;

  const key = event.key.toLowerCase();
  if (key === s.key) return true;
  const code = codeFor(s.key);
  return code !== null && event.code === code;
}

const MAC_SYMBOLS: Record<string, string> = {
  mod: "⌘",
  meta: "⌘",
  ctrl: "⌃",
  alt: "⌥",
  shift: "⇧",
};

const KEY_LABELS: Record<string, string> = {
  enter: "↵",
  escape: "Esc",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  backspace: "⌫",
  delete: "Del",
  tab: "Tab",
  " ": "Space",
};

/**
 * The individual key caps of a shortcut, in display order, e.g.
 * `["⌘", "⇧", "N"]` on macOS or `["Ctrl", "Shift", "N"]` elsewhere.
 */
export function shortcutKeys(shortcut: string, mac: boolean = isMacPlatform()): string[] {
  const s = parseShortcut(shortcut);
  const keys: string[] = [];
  if (mac) {
    if (s.ctrl) keys.push(MAC_SYMBOLS.ctrl);
    if (s.alt) keys.push(MAC_SYMBOLS.alt);
    if (s.shift) keys.push(MAC_SYMBOLS.shift);
    if (s.mod || s.meta) keys.push(MAC_SYMBOLS.mod);
  } else {
    if (s.mod || s.ctrl) keys.push("Ctrl");
    if (s.meta) keys.push("Win");
    if (s.alt) keys.push("Alt");
    if (s.shift) keys.push("Shift");
  }
  keys.push(KEY_LABELS[s.key] ?? (s.key.length === 1 ? s.key.toUpperCase() : s.key[0].toUpperCase() + s.key.slice(1)));
  return keys;
}

/** Compact display string: `⌘⇧N` on macOS, `Ctrl+Shift+N` elsewhere. */
export function formatShortcut(shortcut: string, mac: boolean = isMacPlatform()): string {
  const keys = shortcutKeys(shortcut, mac);
  return mac ? keys.join("") : keys.join("+");
}

/** True when the event originates from a text-editing surface. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}
