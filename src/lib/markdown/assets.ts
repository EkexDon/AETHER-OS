/**
 * Where a media reference in a note (`![alt](img.png)`, `![[img.png]]`)
 * points inside the vault. Pure string logic, no I/O: the resolver in
 * `vaultAssets.ts` tries the candidates in order through
 * `cmd_read_vault_asset`, which re-checks every path in Rust.
 *
 * Lookup order (Obsidian's behaviour, plus the common attachment folders):
 * 1. relative to the note's folder,
 * 2. relative to the vault root,
 * 3. by file name in an `attachments`/`assets` folder next to the note or
 *    in any folder above it, up to the vault root.
 */

/** What a media file is rendered as. */
export type MediaKind = "image" | "video" | "audio" | "pdf";

/** Extensions `cmd_read_vault_asset` serves (mirrors `ASSET_TYPES` in `vault_reader.rs`). */
const EXTENSION_KIND: Record<string, MediaKind> = {
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  svg: "image",
  bmp: "image",
  mp4: "video",
  webm: "video",
  mov: "video",
  mp3: "audio",
  m4a: "audio",
  wav: "audio",
  pdf: "pdf",
};

/** Folder names searched for attachments by file name, per folder level. */
export const ATTACHMENT_FOLDERS = ["attachments", "assets", "Attachments", "Assets"] as const;

/** Drop `?query` and `#fragment` (e.g. `doc.pdf#page=3`). */
function stripSuffix(path: string): string {
  return path.replace(/[?#].*$/, "");
}

/** Media kind of a file name or path by extension, `null` for anything else. */
export function mediaKindOf(path: string): MediaKind | null {
  const match = /\.([A-Za-z0-9]+)$/.exec(stripSuffix(path.trim()));
  if (!match) return null;
  const kind = EXTENSION_KIND[match[1].toLowerCase()];
  return kind ?? null;
}

/** Media kind of a MIME type (`image/png` → `image`), `null` when it is not media. */
export function mediaKindOfMime(mime: string): MediaKind | null {
  const m = mime.toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  if (m === "application/pdf") return "pdf";
  return null;
}

/** `http(s):` URLs are loaded directly; they are not vault files. */
export function isRemoteSrc(src: string): boolean {
  return /^https?:\/\//i.test(src.trim());
}

/** `data:image/…` sources are rendered as they are (other `data:` types are not). */
export function isInlineImageSrc(src: string): boolean {
  return /^data:image\/[a-z0-9.+-]+[;,]/i.test(src.trim());
}

/** Any URL scheme (`https:`, `javascript:`, `C:` is not one — drive letters are paths). */
export function hasUrlScheme(src: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(src.trim()) && !/^[a-z]:[\\/]/i.test(src.trim());
}

/** A parsed Obsidian embed: `![[file.png|alt]]`, `![[file.png|300]]`, `![[file.png|300x200]]`. */
export interface WikiEmbed {
  target: string;
  alt: string;
  width: number | null;
  height: number | null;
}

/** Parse the inside of `![[…]]`. */
export function parseWikiEmbed(inner: string): WikiEmbed {
  const [rawTarget, ...rest] = inner.split("|");
  const target = rawTarget.trim();
  const option = rest.join("|").trim();
  const size = /^(\d{1,5})(?:x(\d{1,5}))?$/.exec(option);
  if (size) {
    return { target, alt: fileName(target), width: Number(size[1]), height: size[2] ? Number(size[2]) : null };
  }
  return { target, alt: option || fileName(target), width: null, height: null };
}

/** Last path segment without query or fragment. */
export function fileName(path: string): string {
  const clean = stripSuffix(path).replace(/\\/g, "/").replace(/\/+$/, "");
  return clean.slice(clean.lastIndexOf("/") + 1);
}

function toPosix(path: string): string {
  return path.replace(/\\/g, "/");
}

function trimSlashes(path: string): string {
  return path.replace(/^\/+|\/+$/g, "");
}

/**
 * Normalise a vault-relative path: resolve `.` and `..`, collapse
 * slashes. Returns `null` when `..` would leave the vault or a segment is
 * hidden-system territory (`.git`).
 */
export function normalizeRelative(path: string): string | null {
  const out: string[] = [];
  for (const segment of toPosix(path).split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    if (segment === ".git") return null;
    out.push(segment);
  }
  return out.length > 0 ? out.join("/") : null;
}

/** Decode `%20` etc. and strip `<…>` wrappers; invalid escapes are kept as they are. */
export function decodeRef(ref: string): string {
  let value = ref.trim();
  if (value.startsWith("<") && value.endsWith(">")) value = value.slice(1, -1).trim();
  try {
    value = decodeURI(value);
  } catch {
    // Keep a literal "%" that is not an escape.
  }
  return stripSuffix(toPosix(value));
}

/** Folder of the note relative to the vault root ("" = root, `null` = outside the vault). */
export function noteFolder(notePath: string | null | undefined, vaultRoot: string | null | undefined): string | null {
  if (!notePath || !vaultRoot) return notePath ? null : "";
  const root = toPosix(vaultRoot).replace(/\/+$/, "");
  const note = toPosix(notePath);
  if (!note.startsWith(`${root}/`)) return null;
  const rel = note.slice(root.length + 1);
  const slash = rel.lastIndexOf("/");
  return slash === -1 ? "" : rel.slice(0, slash);
}

/**
 * Vault-relative paths to try, in order, for a media reference in the note
 * at `notePath` (absolute; `null` for content that is not a vault note).
 * Absolute references inside the vault become vault-relative; other
 * absolute references are read as vault-root relative (Obsidian's
 * `/attachments/x.png`). Remote and inline sources yield no candidates.
 */
export function assetCandidates(ref: string, notePath: string | null | undefined, vaultRoot: string | null | undefined): string[] {
  if (!ref.trim() || isRemoteSrc(ref) || hasUrlScheme(ref)) return [];
  const target = decodeRef(ref);
  if (target.endsWith("/")) return [];
  const name = fileName(target);
  if (!name || name === "." || name === "..") return [];
  const root = vaultRoot ? toPosix(vaultRoot).replace(/\/+$/, "") : null;
  const folder = noteFolder(notePath, vaultRoot) ?? "";

  const ordered: (string | null)[] = [];
  const isAbsolute = target.startsWith("/") || /^[a-z]:\//i.test(target);
  if (isAbsolute) {
    if (root && (target === root || target.startsWith(`${root}/`))) ordered.push(normalizeRelative(target.slice(root.length + 1)));
    else if (target.startsWith("/")) ordered.push(normalizeRelative(trimSlashes(target)));
  } else {
    if (folder) ordered.push(normalizeRelative(`${folder}/${target}`));
    ordered.push(normalizeRelative(target));
  }

  // By file name in attachment folders: the note's folder first, then every folder above it.
  const levels: string[] = [];
  let level: string | null = folder;
  while (level !== null) {
    levels.push(level);
    level = level ? (level.includes("/") ? level.slice(0, level.lastIndexOf("/")) : "") : null;
  }
  for (const dir of levels) {
    for (const attachments of ATTACHMENT_FOLDERS) {
      ordered.push(normalizeRelative(dir ? `${dir}/${attachments}/${name}` : `${attachments}/${name}`));
    }
  }

  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of ordered) {
    if (candidate && !seen.has(candidate)) {
      seen.add(candidate);
      out.push(candidate);
    }
  }
  return out;
}
