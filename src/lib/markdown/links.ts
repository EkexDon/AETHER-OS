/**
 * What a Markdown link may do. The renderer never lets the webview
 * navigate: web and mail links go to the system browser, relative links
 * open a note of this vault, `#anchors` stay inert and every other scheme
 * (`javascript:`, `data:`, `file:`, `vbscript:`, app-internal schemes) is
 * dropped. react-markdown's `defaultUrlTransform` already blanks unsafe
 * URLs; this is the second, explicit line of defence.
 */
import type { VaultNote } from "../../types";
import { decodeRef, normalizeRelative, noteFolder } from "./assets";

/** Classified link target. */
export type LinkTarget =
  | { kind: "external"; url: string }
  | { kind: "note"; path: string }
  | { kind: "anchor" }
  | { kind: "blocked" };

/** Decide what clicking `href` may do. */
export function classifyLink(href: string | null | undefined): LinkTarget {
  const raw = (href ?? "").trim();
  if (!raw) return { kind: "blocked" };
  if (raw.startsWith("#")) return { kind: "anchor" };
  // Protocol-relative (`//host`) and backslash tricks (`\\host`, `/\host`) are not links we can reason about.
  if (/^[\\/]{2}/.test(raw) || /^\/\\/.test(raw)) return { kind: "blocked" };
  // Control characters and whitespace inside a scheme are how `java\tscript:` sneaks through naive checks.
  const compact = raw.replace(/[\u0000-\u0020\u007f]+/g, "");
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(compact)?.[1]?.toLowerCase();
  if (scheme) {
    if (/^[a-z]$/.test(scheme)) return { kind: "blocked" }; // `C:\…` — a local file path
    if (scheme === "mailto") return /^mailto:[^\s]+$/i.test(raw) ? { kind: "external", url: raw } : { kind: "blocked" };
    if (scheme !== "http" && scheme !== "https") return { kind: "blocked" };
    try {
      const url = new URL(raw);
      if (!url.hostname || url.username || url.password) return { kind: "blocked" };
      return { kind: "external", url: url.toString() };
    } catch {
      return { kind: "blocked" };
    }
  }
  const path = decodeRef(raw);
  return path ? { kind: "note", path } : { kind: "blocked" };
}

/**
 * The vault note a relative link points to: tried against the note's
 * folder, then the vault root, with and without an added `.md`. Only notes
 * that exist in `vaultNotes` are returned.
 */
export function findLinkedNote(
  path: string,
  notePath: string | null | undefined,
  vaultRoot: string | null | undefined,
  vaultNotes: readonly VaultNote[]
): VaultNote | null {
  if (!vaultRoot) return null;
  const root = vaultRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  const folder = noteFolder(notePath, vaultRoot) ?? "";
  const bases = path.startsWith("/") ? [path.replace(/^\/+/, "")] : folder ? [`${folder}/${path}`, path] : [path];
  const wanted = new Set<string>();
  for (const base of bases) {
    const rel = normalizeRelative(base);
    if (!rel) continue;
    wanted.add(`${root}/${rel}`.toLowerCase());
    if (!/\.md$/i.test(rel)) wanted.add(`${root}/${rel}.md`.toLowerCase());
  }
  return vaultNotes.find((n) => wanted.has(n.path.replace(/\\/g, "/").toLowerCase())) ?? null;
}

/**
 * The note a `[[wikilink]]` names: by note name (case-insensitive), or by
 * vault-relative path for `[[folder/Note]]`. With several notes of the same
 * name the one closest to the vault root wins (Obsidian's shortest path).
 */
export function findWikilinkNote(target: string, vaultRoot: string | null | undefined, vaultNotes: readonly VaultNote[]): VaultNote | null {
  const wanted = target.trim().replace(/\.md$/i, "").toLowerCase();
  if (!wanted) return null;
  const root = (vaultRoot ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  const matches = vaultNotes.filter((n) => {
    if (n.name.toLowerCase() === wanted) return true;
    const path = n.path.replace(/\\/g, "/").toLowerCase();
    return wanted.includes("/") && path.endsWith(`/${wanted}.md`) && (!root || path.startsWith(`${root.toLowerCase()}/`));
  });
  if (matches.length === 0) return null;
  return [...matches].sort((a, b) => a.path.split(/[\\/]/).length - b.path.split(/[\\/]/).length)[0];
}
