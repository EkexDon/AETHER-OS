import type { LucideIcon } from "lucide-react";
import {
  AppWindow,
  Bookmark,
  Brain,
  CalendarDays,
  ClipboardList,
  Clock3,
  FileCode2,
  FileText,
  FolderGit2,
  MessagesSquare,
  SquareCheckBig,
  TerminalSquare,
} from "lucide-react";
import type { SearchKind } from "../../types";

/** Every kind the backend index holds, in indexing order. */
export const SEARCH_KINDS: SearchKind[] = ["note", "project", "file", "memory", "conversation", "event", "task", "app"];

/**
 * Launcher sections. Backend kinds plus the client-side sources
 * (recents, commands, browser bookmarks, clipboard history).
 */
export type LauncherSection = "recents" | "commands" | SearchKind | "bookmark" | "clipboard";

/** Section order in the launcher (and tab order in the Search view). */
export const SECTION_ORDER: LauncherSection[] = [
  "recents",
  "commands",
  "note",
  "project",
  "file",
  "app",
  "event",
  "task",
  "memory",
  "conversation",
  "bookmark",
  "clipboard",
];

interface SectionMeta {
  /** Section heading / tab label. */
  label: string;
  /** Singular noun for one result. */
  singular: string;
  icon: LucideIcon;
}

/** Display metadata of every section. */
export const SECTION_META: Record<LauncherSection, SectionMeta> = {
  recents: { label: "Recent", singular: "Recent", icon: Clock3 },
  commands: { label: "Commands", singular: "Command", icon: TerminalSquare },
  note: { label: "Notes", singular: "Note", icon: FileText },
  project: { label: "Projects", singular: "Project", icon: FolderGit2 },
  file: { label: "Files", singular: "File", icon: FileCode2 },
  app: { label: "Apps", singular: "App", icon: AppWindow },
  event: { label: "Events", singular: "Event", icon: CalendarDays },
  task: { label: "Tasks", singular: "Task", icon: SquareCheckBig },
  memory: { label: "Memory", singular: "Memory fact", icon: Brain },
  conversation: { label: "Conversations", singular: "Conversation", icon: MessagesSquare },
  bookmark: { label: "Bookmarks", singular: "Bookmark", icon: Bookmark },
  clipboard: { label: "Clipboard", singular: "Clip", icon: ClipboardList },
};

/** Type guard: is `value` a backend {@link SearchKind}? */
export function isSearchKind(value: string): value is SearchKind {
  return (SEARCH_KINDS as string[]).includes(value);
}
