/**
 * External editors (Settings → Editor, Projects, launcher): display names
 * and the validation rule for a custom editor. Rust (`resolve_editor` in
 * `project_commands.rs`) launches a known key through its app and CLI shim
 * and anything else only as `open -a "<App name>"`, so a custom editor
 * must be a plain macOS application name — never a path or an option.
 */

const EDITOR_NAMES: Record<string, string> = {
  devin: "Devin",
  windsurf: "Windsurf",
  cursor: "Cursor",
  code: "VS Code",
  vscode: "VS Code",
};

/** Longest application name Rust accepts. */
export const EDITOR_NAME_MAX = 100;

/**
 * Display name of an editor key stored in `preferredEditor`: known keys
 * map to product names, a custom app name is shown as typed, a legacy
 * path shows its last segment, and an empty value reads "your editor".
 */
export function editorLabel(editor: string | null | undefined): string {
  const trimmed = (editor ?? "").trim();
  if (!trimmed) return "your editor";
  const key = trimmed.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(EDITOR_NAMES, key)) return EDITOR_NAMES[key];
  if (/[\\/]/.test(trimmed)) {
    const last = trimmed.split(/[\\/]/).filter(Boolean).pop() ?? trimmed;
    return last.replace(/\.app$/i, "");
  }
  return trimmed;
}

/**
 * Why `name` cannot be used as a custom editor, or `null`. Same rules as
 * Rust: not empty, at most 100 characters, no leading `-` or `.`, no
 * `/`, `\`, `:` or control characters.
 */
export function editorNameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Enter the application's name.";
  if ([...trimmed].length > EDITOR_NAME_MAX) return `Use at most ${EDITOR_NAME_MAX} characters.`;
  if (/[\\/:]/.test(trimmed)) return "Enter the app's name as it appears in Applications (e.g. Zed), not a path.";
  if (/^[-.]/.test(trimmed)) return "The name cannot start with “-” or “.”.";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(trimmed)) return "The name contains invisible control characters.";
  return null;
}
