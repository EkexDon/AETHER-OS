/**
 * Pure model of the launcher list: building items from every source,
 * grouping them into ordered sections and keyboard navigation between
 * sections. Kept free of React so it is unit-testable.
 */
import type { LucideIcon } from "lucide-react";
import { CornerDownLeft } from "lucide-react";
import type { ClipItem, RecentHit, SearchHit } from "../../types";
import type { CommandContribution } from "../commands/registry";
import { COMMAND_GROUPS } from "../commands/registry";
import { launcherScore, matchPositions } from "./fuzzy";
import { frecencyBoost } from "./frecency";
import { SECTION_META, SECTION_ORDER, type LauncherSection } from "./kinds";
import { QUERY_PREFIXES } from "./prefix";
import { hostOf, type BookmarkEntry } from "./sources";

/** What selecting a launcher item does. */
export type LauncherAction =
  | { type: "command"; id: string; title: string }
  | { type: "hit"; hit: SearchHit }
  | { type: "bookmark"; url: string; title: string }
  | { type: "clip"; id: string; preview: string }
  | { type: "prefix"; prefix: string };

/** One row of the launcher. */
export interface LauncherItem {
  /** Unique within the list. */
  key: string;
  section: LauncherSection;
  title: string;
  subtitle?: string;
  /** Title characters to highlight. */
  titlePositions: number[];
  /** Backend snippet (escaped, with `<mark>`). */
  snippetHtml?: string;
  /** Keyboard shortcut shown on the right (commands). */
  shortcut?: string;
  icon: LucideIcon;
  score: number;
  action: LauncherAction;
}

/** A titled run of items; `start` is the flat index of its first item. */
export interface LauncherGroup {
  section: LauncherSection;
  label: string;
  items: LauncherItem[];
  start: number;
}

/** Commands that make no sense inside the launcher itself. */
export const HIDDEN_COMMAND_IDS = new Set(["app.commandPalette", "search.launcher"]);

/** Built-in command groups in browse order (feature groups follow). */
const COMMAND_GROUP_ORDER: string[] = [
  COMMAND_GROUPS.navigation,
  COMMAND_GROUPS.capture,
  "Search",
  COMMAND_GROUPS.agent,
  COMMAND_GROUPS.general,
  COMMAND_GROUPS.appearance,
];

/**
 * Launcher items for commands. With a query they are fuzzy-ranked (title,
 * group, keywords) and boosted by frecency; without one (browse mode) they
 * keep the registry order grouped by {@link COMMAND_GROUP_ORDER}, with
 * frequently used commands first.
 */
export function commandItems(
  commands: CommandContribution[],
  query: string,
  frecencyById: Map<string, number> = new Map()
): LauncherItem[] {
  const q = query.trim();
  const rank = (group: string) => {
    const i = COMMAND_GROUP_ORDER.indexOf(group);
    return i < 0 ? COMMAND_GROUP_ORDER.length : i;
  };
  const items = commands
    .filter((c) => !HIDDEN_COMMAND_IDS.has(c.id))
    .map((c, index) => {
      const base = launcherScore(q, c.title, [c.group, ...(c.keywords ?? [])]);
      const boost = frecencyBoost(frecencyById.get(`command:${c.id}`) ?? 0);
      const item: LauncherItem = {
        key: `command:${c.id}`,
        section: "commands",
        title: c.title,
        subtitle: c.group,
        titlePositions: q ? matchPositions(q, c.title) : [],
        shortcut: c.shortcut,
        icon: c.icon ?? CornerDownLeft,
        score: base * boost,
        action: { type: "command", id: c.id, title: c.title },
      };
      return { item, index, group: rank(c.group), boost };
    })
    .filter(({ item }) => item.score > 0);
  if (q) {
    return items.sort((a, b) => b.item.score - a.item.score || a.index - b.index).map(({ item }) => item);
  }
  return items
    .sort((a, b) => b.boost - a.boost || a.group - b.group || a.index - b.index)
    .map(({ item }) => item);
}

/** Launcher items for backend hits (section = hit kind, backend order kept). */
export function hitItems(hits: SearchHit[], query: string): LauncherItem[] {
  return hits.map((hit, index) => ({
    key: hit.id,
    section: hit.kind,
    title: hit.title,
    subtitle: hit.subtitle,
    titlePositions: matchPositions(query, hit.title),
    snippetHtml: hit.snippet_html || undefined,
    icon: SECTION_META[hit.kind].icon,
    score: hit.score * 1000 - index,
    action: { type: "hit", hit },
  }));
}

/** Launcher items for matching bookmarks. */
export function bookmarkItems(matches: { bookmark: BookmarkEntry; score: number }[], query: string): LauncherItem[] {
  return matches.map(({ bookmark, score }) => ({
    key: `bookmark:${bookmark.url}`,
    section: "bookmark",
    title: bookmark.title,
    subtitle: hostOf(bookmark.url),
    titlePositions: matchPositions(query, bookmark.title),
    icon: SECTION_META.bookmark.icon,
    score,
    action: { type: "bookmark", url: bookmark.url, title: bookmark.title },
  }));
}

/** Launcher items for clipboard-history matches. */
export function clipItems(clips: ClipItem[], query: string): LauncherItem[] {
  return clips.map((clip, index) => {
    const preview = clip.preview || clip.content.slice(0, 200);
    return {
      key: `clip:${clip.id}`,
      section: "clipboard",
      title: preview,
      subtitle: `${clip.kind}${clip.pinned ? " · pinned" : ""}`,
      titlePositions: matchPositions(query, preview),
      icon: SECTION_META.clipboard.icon,
      score: 100 - index,
      action: { type: "clip", id: clip.id, preview },
    };
  });
}

/**
 * Launcher items for recents (empty query). Indexed kinds come resolved
 * from the backend; commands are looked up in the registry (and dropped
 * when they no longer exist or are disabled); bookmarks and clips reuse
 * their remembered title.
 */
export function recentItems(recents: RecentHit[], commands: CommandContribution[]): LauncherItem[] {
  const byId = new Map(commands.map((c) => [c.id, c]));
  const items: LauncherItem[] = [];
  for (const recent of recents) {
    const score = recent.frecency;
    if (recent.hit) {
      items.push({
        key: `recent:${recent.id}`,
        section: "recents",
        title: recent.hit.title,
        subtitle: recent.hit.subtitle,
        titlePositions: [],
        icon: SECTION_META[recent.hit.kind].icon,
        score,
        action: { type: "hit", hit: recent.hit },
      });
    } else if (recent.kind === "command") {
      const command = byId.get(recent.id.replace(/^command:/, ""));
      if (!command || HIDDEN_COMMAND_IDS.has(command.id)) continue;
      items.push({
        key: `recent:${recent.id}`,
        section: "recents",
        title: command.title,
        subtitle: command.group,
        titlePositions: [],
        shortcut: command.shortcut,
        icon: command.icon ?? CornerDownLeft,
        score,
        action: { type: "command", id: command.id, title: command.title },
      });
    } else if (recent.kind === "bookmark") {
      const url = recent.id.replace(/^bookmark:/, "");
      if (!/^https?:\/\//i.test(url)) continue;
      const title = recent.title ?? url;
      items.push({
        key: `recent:${recent.id}`,
        section: "recents",
        title,
        subtitle: hostOf(url),
        titlePositions: [],
        icon: SECTION_META.bookmark.icon,
        score,
        action: { type: "bookmark", url, title },
      });
    } else if (recent.kind === "clip" && recent.title) {
      items.push({
        key: `recent:${recent.id}`,
        section: "recents",
        title: recent.title,
        subtitle: "Clipboard",
        titlePositions: [],
        icon: SECTION_META.clipboard.icon,
        score,
        action: { type: "clip", id: recent.id.replace(/^clip:/, ""), preview: recent.title },
      });
    }
  }
  return items;
}

/** The `?` help list: one item per query prefix. */
export function helpItems(): LauncherItem[] {
  return QUERY_PREFIXES.filter((p) => p.mode !== "help").map((p, index) => ({
    key: `prefix:${p.prefix}`,
    section: "commands",
    title: `${p.prefix}  ${p.label}`,
    subtitle: `${p.description} — e.g. ${p.example}`,
    titlePositions: [],
    icon: CornerDownLeft,
    score: 100 - index,
    action: { type: "prefix", prefix: p.prefix },
  }));
}

/**
 * Group items into sections in `order` (default {@link SECTION_ORDER}), keeping each
 * section's own order and capping it at `limits[section]` (or
 * `defaultLimit`). Empty sections are dropped.
 */
export function groupItems(
  items: LauncherItem[],
  limits: Partial<Record<LauncherSection, number>> = {},
  defaultLimit = 8,
  labels: Partial<Record<LauncherSection, string>> = {},
  order: LauncherSection[] = SECTION_ORDER
): LauncherGroup[] {
  const buckets = new Map<LauncherSection, LauncherItem[]>();
  for (const item of items) {
    const list = buckets.get(item.section) ?? [];
    const cap = limits[item.section] ?? defaultLimit;
    if (list.length < cap) list.push(item);
    buckets.set(item.section, list);
  }
  const groups: LauncherGroup[] = [];
  let start = 0;
  for (const section of order) {
    const list = buckets.get(section);
    if (!list || list.length === 0) continue;
    groups.push({ section, label: labels[section] ?? SECTION_META[section].label, items: list, start });
    start += list.length;
  }
  return groups;
}

/** All items of the groups in display order. */
export function flattenGroups(groups: LauncherGroup[]): LauncherItem[] {
  return groups.flatMap((g) => g.items);
}

/**
 * Flat index of the first item of the next (`direction = 1`) or previous
 * (`-1`) section relative to `index`, cycling around. Going back from the
 * middle of a section first jumps to that section's start.
 */
export function sectionJump(groups: LauncherGroup[], index: number, direction: 1 | -1): number {
  if (groups.length === 0) return 0;
  const current = groups.findIndex((g) => index >= g.start && index < g.start + g.items.length);
  const at = current < 0 ? 0 : current;
  if (direction === -1 && current >= 0 && index > groups[at].start) return groups[at].start;
  const next = (at + direction + groups.length) % groups.length;
  return groups[next].start;
}

/** Section order for "Go to file" (`/`): files before notes. */
export const FILES_FIRST_ORDER: LauncherSection[] = [
  "file",
  ...SECTION_ORDER.filter((section) => section !== "file"),
];
