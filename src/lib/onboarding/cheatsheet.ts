/**
 * Shortcut listing for Settings → Shortcuts and the Markdown cheat sheet.
 * Commands come from the command registry; editor-local shortcuts (which are
 * not global commands) come from the shortcuts overlay's
 * `CONTEXT_SHORTCUTS`, so all three lists always agree.
 */
import { scoreFields } from "../commands/fuzzy";
import { formatShortcut, isMacPlatform } from "../shortcuts";
import { CONTEXT_SHORTCUTS, type ContextShortcutGroup } from "../../shell/ShortcutsOverlay";

/** One row of the shortcut list. */
export interface ShortcutEntry {
  /** Command id, or `"<group>:<title>"` for editor-local shortcuts. */
  id: string;
  title: string;
  group: string;
  /** Shortcut string (`mod+k`), `null` when the command has none. */
  shortcut: string | null;
  /** Extra search words. */
  keywords: string[];
  /** Editor-local shortcuts cannot be run from the list. */
  runnable: boolean;
}

/** A titled group of shortcut rows. */
export interface ShortcutGroup {
  group: string;
  entries: ShortcutEntry[];
}

/** The subset of a registry command this module needs. */
export interface CommandLike {
  id: string;
  title: string;
  group: string;
  shortcut?: string;
  keywords?: string[];
}

/**
 * Group registry commands (first-seen group order) followed by the
 * editor-local shortcuts. Duplicate command ids keep their first entry.
 */
export function collectShortcuts(
  commands: CommandLike[],
  editor: readonly ContextShortcutGroup[] = CONTEXT_SHORTCUTS
): ShortcutGroup[] {
  const groups = new Map<string, ShortcutEntry[]>();
  const seen = new Set<string>();
  const push = (entry: ShortcutEntry) => {
    const list = groups.get(entry.group);
    if (list) list.push(entry);
    else groups.set(entry.group, [entry]);
  };
  for (const c of commands) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    push({
      id: c.id,
      title: c.title,
      group: c.group,
      shortcut: c.shortcut ?? null,
      keywords: c.keywords ?? [],
      runnable: true,
    });
  }
  for (const g of editor) {
    for (const item of g.items) {
      push({
        id: `${g.group}:${item.title}`,
        title: item.title,
        group: g.group,
        shortcut: item.shortcut,
        keywords: [],
        runnable: false,
      });
    }
  }
  return Array.from(groups, ([group, entries]) => ({ group, entries }));
}

/** Keep entries matching `query` (fuzzy on title, group, keywords and the shortcut text). */
export function filterShortcuts(groups: ShortcutGroup[], query: string, mac: boolean = isMacPlatform()): ShortcutGroup[] {
  const q = query.trim();
  if (!q) return groups;
  return groups
    .map((g) => ({
      group: g.group,
      entries: g.entries.filter(
        (e) =>
          scoreFields(q, e.title, [e.group, ...e.keywords, ...(e.shortcut ? [formatShortcut(e.shortcut, mac), e.shortcut] : [])]) > 0
      ),
    }))
    .filter((g) => g.entries.length > 0);
}

/** Only entries that actually have a shortcut. */
export function withShortcutsOnly(groups: ShortcutGroup[]): ShortcutGroup[] {
  return groups
    .map((g) => ({ group: g.group, entries: g.entries.filter((e) => e.shortcut) }))
    .filter((g) => g.entries.length > 0);
}

function cell(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/**
 * A Markdown cheat sheet: one `##` section per group with an
 * `Action | Shortcut` table. Commands without a shortcut are left out.
 */
export function buildCheatSheet(
  groups: ShortcutGroup[],
  options: { mac?: boolean; title?: string; version?: string } = {}
): string {
  const mac = options.mac ?? isMacPlatform();
  const title = options.title ?? "AETHER-OS keyboard shortcuts";
  const lines: string[] = [`# ${title}`, ""];
  lines.push(
    `${options.version ? `Version ${options.version} · ` : ""}${mac ? "⌘ = Command, ⇧ = Shift, ⌥ = Option, ⌃ = Control" : "Ctrl, Shift and Alt as printed"}.`,
    ""
  );
  for (const g of withShortcutsOnly(groups)) {
    lines.push(`## ${g.group}`, "", "| Action | Shortcut |", "| --- | --- |");
    for (const e of g.entries) {
      lines.push(`| ${cell(e.title)} | \`${cell(formatShortcut(e.shortcut as string, mac))}\` |`);
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
