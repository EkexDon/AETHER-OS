import { MarkdownRenderer } from "../MarkdownRenderer";

/**
 * Release notes rendered with the app's Markdown renderer. Kept in its own
 * module so callers can `lazy()`-load it and the renderer (with mermaid)
 * never lands in the startup path of the status bar or settings registry.
 */
export default function ReleaseNotes({ markdown }: { markdown: string }) {
  return (
    <div className="ob-release-notes">
      <MarkdownRenderer content={markdown} />
    </div>
  );
}
