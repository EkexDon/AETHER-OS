import type { SearchKind } from "../../types";

/** What a query prefix restricts the search to. */
export type PrefixMode = "all" | "commands" | "tags" | "files" | "people" | "help";

/** One documented query prefix (shown by `?`). */
export interface QueryPrefix {
  prefix: ">" | "#" | "/" | "@" | "?";
  mode: Exclude<PrefixMode, "all">;
  label: string;
  description: string;
  /** Example query shown in the help list. */
  example: string;
}

/** Every prefix the launcher and the Search view understand. */
export const QUERY_PREFIXES: QueryPrefix[] = [
  { prefix: ">", mode: "commands", label: "Commands", description: "Run a command", example: "> theme" },
  { prefix: "#", mode: "tags", label: "Tags", description: "Notes, events and tasks with a tag", example: "#project" },
  { prefix: "/", mode: "files", label: "Files", description: "Project files and notes by path", example: "/src main" },
  { prefix: "@", mode: "people", label: "People & memory", description: "Memory facts and AI conversations", example: "@anna" },
  { prefix: "?", mode: "help", label: "Help", description: "List these prefixes", example: "?" },
];

/** A parsed launcher / Search view query. */
export interface ParsedQuery {
  mode: PrefixMode;
  /** The prefix character, `""` when none. */
  prefix: string;
  /** The text after the prefix, trimmed. */
  text: string;
  /** Backend kinds to search (`null` = all enabled kinds). */
  kinds: SearchKind[] | null;
  /** The `q` sent to `cmd_search_query` (`""` = no backend query). */
  backendQuery: string;
  /** Include commands (client-side) in the results. */
  includeCommands: boolean;
  /** Include bookmarks and clipboard items (client-side). */
  includeExtras: boolean;
}

const KINDS_BY_MODE: Partial<Record<PrefixMode, SearchKind[]>> = {
  files: ["file", "note"],
  people: ["memory", "conversation"],
};

/**
 * Split a raw query into its prefix mode and search text. Only the very
 * first non-blank character counts as a prefix, so `c++ >` is a plain
 * query.
 */
export function parseQuery(raw: string): ParsedQuery {
  const trimmed = raw.trimStart();
  const first = trimmed.charAt(0);
  const known = QUERY_PREFIXES.find((p) => p.prefix === first);
  if (!known) {
    const text = raw.trim();
    return {
      mode: "all",
      prefix: "",
      text,
      kinds: null,
      backendQuery: text,
      includeCommands: true,
      includeExtras: true,
    };
  }
  const text = trimmed.slice(1).trim();
  switch (known.mode) {
    case "commands":
      return { mode: "commands", prefix: ">", text, kinds: null, backendQuery: "", includeCommands: true, includeExtras: false };
    case "tags":
      return {
        mode: "tags",
        prefix: "#",
        text,
        kinds: null,
        // The backend treats a leading `#` as a tag-only query.
        backendQuery: text ? `#${text}` : "",
        includeCommands: false,
        includeExtras: false,
      };
    case "help":
      return { mode: "help", prefix: "?", text, kinds: null, backendQuery: "", includeCommands: false, includeExtras: false };
    default:
      return {
        mode: known.mode,
        prefix: known.prefix,
        text,
        kinds: KINDS_BY_MODE[known.mode] ?? null,
        backendQuery: text,
        includeCommands: false,
        includeExtras: false,
      };
  }
}

/** Human-readable placeholder for the input in a prefix mode. */
export function placeholderFor(mode: PrefixMode): string {
  switch (mode) {
    case "commands":
      return "Run a command…";
    case "tags":
      return "Search tags…";
    case "files":
      return "Go to file…";
    case "people":
      return "Search people and memory…";
    case "help":
      return "Pick a prefix…";
    default:
      return "Search notes, files, apps, commands…";
  }
}
