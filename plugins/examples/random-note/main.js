/**
 * Random Note — an AETHER-OS example plugin.
 *
 * Registers "Open random note" (⌥⇧⌘O): picks a random note from the vault,
 * skipping the folders listed in the plugin settings and the note that is
 * already open, and opens it in the editor.
 *
 * Permissions: vault:read, ui:commands.
 */

/**
 * Parse the comma-separated "Skip folders" setting into normalised prefixes.
 * @param {string} value
 * @returns {string[]}
 */
export function parseFolders(value) {
  return String(value ?? "")
    .split(",")
    .map((part) => part.trim().replace(/^\/+|\/+$/g, "").toLowerCase())
    .filter(Boolean);
}

/**
 * Pick a random note that is not inside an excluded folder and is not the
 * current note. Returns `null` when nothing qualifies.
 * @param {{ path: string }[]} notes
 * @param {string[]} excluded folder prefixes (lowercase)
 * @param {string | null} currentPath
 * @param {() => number} [random]
 * @returns {{ path: string } | null}
 */
export function pickRandomNote(notes, excluded, currentPath, random = Math.random) {
  const candidates = notes.filter((note) => {
    const path = note.path.toLowerCase();
    if (currentPath && note.path === currentPath) return false;
    return !excluded.some((folder) => path === folder || path.startsWith(`${folder}/`));
  });
  if (candidates.length === 0) return null;
  const index = Math.min(candidates.length - 1, Math.floor(random() * candidates.length));
  return candidates[index];
}

/**
 * Plugin entry point, called once by AETHER-OS.
 * @param {object} api the AETHER plugin API (see docs/PLUGIN-API.md)
 */
export async function activate(api) {
  await api.commands.register({
    id: "open",
    title: "Open random note",
    shortcut: "mod+alt+shift+o",
    run: async () => {
      const [notes, settings, current] = await Promise.all([
        api.vault.list(),
        api.settings.get(),
        api.notes.current(),
      ]);
      const note = pickRandomNote(notes, parseFolders(settings.excludeFolders), current?.path ?? null);
      if (!note) {
        await api.ui.toast("No note to pick — every note is in a skipped folder.", "info");
        return;
      }
      await api.notes.open(note.path);
    },
  });
}
