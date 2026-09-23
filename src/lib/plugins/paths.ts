/**
 * Vault path helpers for the plugin host. Plugins only ever see
 * vault-relative POSIX paths (`daily/2026-09-22.md`); the host converts
 * them to the absolute paths the rest of the app uses and back.
 */

/**
 * Validate a vault-relative note path (same rules as `sanitize_vault_path`
 * in Rust): no absolute paths, backslashes, drive letters, `.`/`..` or
 * hidden segments, and it must name a `.md` file. Returns the normalised
 * path or throws.
 */
export function sanitizeVaultPath(path: string): string {
  const bad = () => new Error(`invalid vault path "${path}": use a vault-relative path to a .md note`);
  const trimmed = typeof path === "string" ? path.trim() : "";
  if (!trimmed || trimmed.length > 1024 || trimmed.startsWith("/") || /[\\:\0]/.test(trimmed)) throw bad();
  const parts: string[] = [];
  for (const segment of trimmed.split("/")) {
    if (!segment) continue;
    if (segment === "." || segment === ".." || segment.startsWith(".")) throw bad();
    parts.push(segment);
  }
  const joined = parts.join("/");
  if (!joined || !joined.toLowerCase().endsWith(".md")) throw bad();
  return joined;
}

function trimTrailingSeparators(path: string): string {
  return path.replace(/[\\/]+$/, "");
}

/** Vault-relative form of an absolute note path, or `null` when it is outside the vault. */
export function toVaultRelative(absolute: string, vaultRoot: string | null): string | null {
  if (!vaultRoot) return null;
  const root = trimTrailingSeparators(vaultRoot).replace(/\\/g, "/");
  const abs = absolute.replace(/\\/g, "/");
  if (!abs.startsWith(`${root}/`)) return null;
  const rel = abs.slice(root.length + 1);
  return rel && !rel.split("/").some((s) => s === ".." || s === ".") ? rel : null;
}

/** Absolute path of a (sanitised) vault-relative path, using the vault's own separator. */
export function joinVaultPath(vaultRoot: string, relative: string): string {
  const root = trimTrailingSeparators(vaultRoot);
  const separator = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  return `${root}${separator}${relative.split("/").join(separator)}`;
}

/** Note name (file name without `.md`) of a path. */
export function noteName(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  return base.replace(/\.md$/i, "");
}
