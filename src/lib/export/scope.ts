/**
 * Pure helpers for export scopes and destinations (no DOM, no IPC).
 */
import type { ExportFlow, ExportScope, ExportScopeKind, VaultNote } from "../../types";

/** Scope kinds with their picker labels, in picker order. */
export const SCOPE_KINDS: { kind: ExportScopeKind; label: string }[] = [
  { kind: "note", label: "Note" },
  { kind: "folder", label: "Folder" },
  { kind: "vault", label: "Whole vault" },
  { kind: "tag", label: "Tag" },
  { kind: "selection", label: "Selection" },
];

/** Scope kinds a flow supports: a standalone document is always one note. */
export function scopeKindsFor(flow: ExportFlow): ExportScopeKind[] {
  return flow === "html" ? ["note"] : SCOPE_KINDS.map((s) => s.kind);
}

/** An empty scope of `kind`, pre-filled from what the user is looking at. */
export function emptyScope(kind: ExportScopeKind, currentNote: string | null): ExportScope {
  switch (kind) {
    case "note":
      return { kind: "note", value: currentNote ?? "" };
    case "folder":
      return { kind: "folder", value: currentNote ? parentDir(currentNote) : "" };
    case "vault":
      return { kind: "vault" };
    case "tag":
      return { kind: "tag", value: "" };
    case "selection":
      return { kind: "selection", value: currentNote ? [currentNote] : [] };
  }
}

/** Default scope when a flow is opened without one. */
export function defaultScope(flow: ExportFlow, currentNote: string | null): ExportScope {
  return flow === "html" ? emptyScope("note", currentNote) : { kind: "vault" };
}

/** True when the scope has everything it needs to be resolved. */
export function isScopeReady(scope: ExportScope): boolean {
  switch (scope.kind) {
    case "vault":
      return true;
    case "selection":
      return scope.value.length > 0;
    default:
      return scope.value.trim().length > 0;
  }
}

/** Parent directory of a `/`-separated path (`/` for top-level paths). */
export function parentDir(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx <= 0 ? "/" : trimmed.slice(0, idx);
}

/** Last path component. */
export function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

/** Join a directory and a file name with exactly one `/`. */
export function joinPath(dir: string, name: string): string {
  return `${dir.replace(/\/+$/, "")}/${name.replace(/^\/+/, "")}`;
}

/** `path` relative to `root` (`""` for the root itself; `path` if outside). */
export function relativeTo(path: string, root: string | null): string {
  if (!root) return path;
  const base = root.replace(/\/+$/, "");
  if (path === base) return "";
  return path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path;
}

/** True when `path` is the vault root or lies inside it. */
export function isInsideVault(path: string, root: string | null): boolean {
  if (!root || !path.trim()) return false;
  const base = root.replace(/\/+$/, "");
  const p = path.trim().replace(/\/+$/, "");
  return p === base || p.startsWith(`${base}/`);
}

/** Short description of a scope before it is resolved. */
export function scopeSummary(scope: ExportScope, root: string | null): string {
  switch (scope.kind) {
    case "note":
      return scope.value ? baseName(scope.value).replace(/\.md$/i, "") : "No note selected";
    case "folder": {
      if (!scope.value) return "No folder selected";
      const rel = relativeTo(scope.value, root);
      return rel ? `${rel}/` : "Whole vault";
    }
    case "vault":
      return "Whole vault";
    case "tag":
      return scope.value ? `#${scope.value.replace(/^#/, "")}` : "No tag selected";
    case "selection":
      return `${scope.value.length} selected note${scope.value.length === 1 ? "" : "s"}`;
  }
}

/** File-system safe file name from a title (no extension). */
export function safeFileName(title: string): string {
  const cleaned = title
    .replace(/[/\\:*?"<>|\u0000-\u001f]+/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^[.\s-]+|[.\s-]+$/g, "")
    .slice(0, 80)
    .trim();
  return cleaned || "export";
}

/** Suggested destination for a flow, given a folder and a title. */
export function suggestDestination(flow: ExportFlow, dir: string, title: string): string {
  const name = safeFileName(title);
  if (flow === "html") return joinPath(dir, `${name}.html`);
  if (flow === "bundle") return joinPath(dir, `${name}.zip`);
  return joinPath(dir, `${name.toLowerCase().replace(/\s+/g, "-")}-site`);
}

/**
 * A sensible default export folder: the user's Desktop derived from the
 * vault path (`/Users/<name>/…` or `/home/<name>/…`), else the folder that
 * contains the vault.
 */
export function defaultExportDir(vaultRoot: string | null): string {
  if (!vaultRoot) return "";
  const home = /^(\/Users\/[^/]+|\/home\/[^/]+)(?:\/|$)/.exec(vaultRoot);
  if (home) return `${home[1]}/Desktop`;
  return parentDir(vaultRoot);
}

/** A folder of the vault for the folder picker. */
export interface FolderEntry {
  /** Absolute path. */
  path: string;
  /** Path relative to the vault (`""` for the root). */
  rel: string;
  name: string;
  depth: number;
  /** Notes in this folder and below. */
  count: number;
}

/** Every folder that contains notes, depth-first and sorted by name. */
export function folderList(notes: VaultNote[], root: string | null): FolderEntry[] {
  if (!root) return [];
  const base = root.replace(/\/+$/, "");
  const counts = new Map<string, number>();
  counts.set("", notes.length);
  for (const note of notes) {
    const rel = relativeTo(note.path, base);
    const parts = rel.split("/").slice(0, -1);
    for (let i = 1; i <= parts.length; i++) {
      const key = parts.slice(0, i).join("/");
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort(([a], [b]) => {
      if (a === "") return -1;
      if (b === "") return 1;
      return a.toLowerCase().localeCompare(b.toLowerCase());
    })
    .map(([rel, count]) => ({
      path: rel ? `${base}/${rel}` : base,
      rel,
      name: rel ? rel.slice(rel.lastIndexOf("/") + 1) : baseName(base),
      depth: rel ? rel.split("/").length : 0,
      count,
    }));
}

/** Notes matching every word of `query` in name or path (case-insensitive). */
export function filterNotes(notes: VaultNote[], query: string, root: string | null): VaultNote[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return notes;
  return notes.filter((n) => {
    const hay = `${n.name} ${relativeTo(n.path, root)}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}
