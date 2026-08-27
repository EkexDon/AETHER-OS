import { useEffect, useRef, useState } from "react";
import type { editor as MonacoEditor } from "monaco-editor";
import { Loader2, X } from "lucide-react";
import { AETHER_THEME, setupMonaco } from "../lib/monaco";
import { gitDiffFile } from "../lib/ipc";
import { languageForPath } from "../lib/language";

interface IdeDiffViewProps {
  rootPath: string;
  file: string;
  staged: boolean;
  onClose: () => void;
}

/**
 * A Monaco side-by-side diff for one file. Rendered as an overlay above the
 * editor area; closed via Escape or the ✕ button.
 */
export function IdeDiffView({ rootPath, file, staged, onClose }: IdeDiffViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<MonacoEditor.IStandaloneDiffEditor | null>(null);
  const [diff, setDiff] = useState<{ old: string | null; new: string | null; binary: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDiff(null);
    setError(null);
    gitDiffFile(rootPath, file, staged)
      .then((d) => {
        if (!cancelled) setDiff({ old: d.old_content, new: d.new_content, binary: d.is_binary });
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [rootPath, file, staged]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useEffect(() => {
    if (!containerRef.current || !diff || diff.binary) return;
    const monaco = setupMonaco();
    const originalModel = monaco.editor.createModel(diff.old ?? "", languageForPath(file));
    const modifiedModel = monaco.editor.createModel(
      diff.new ?? "",
      languageForPath(file),
      // Naming the model after the file gives proper highlighting and
      // makes the diff gutter read like a real review.
      monaco.Uri.file(`${rootPath}/${file}${staged ? " (staged)" : ""}`)
    );

    const editor = monaco.editor.createDiffEditor(containerRef.current, {
      theme: AETHER_THEME,
      automaticLayout: true,
      readOnly: true,
      renderSideBySide: true,
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'SF Mono', 'Fira Code', Menlo, monospace",
      scrollBeyondLastLine: false,
      renderOverviewRuler: false,
      padding: { top: 10, bottom: 10 },
    });
    editor.setModel({ original: originalModel, modified: modifiedModel });
    editorRef.current = editor;

    return () => {
      editor.dispose();
      originalModel.dispose();
      modifiedModel.dispose();
      editorRef.current = null;
    };
  }, [diff, file, rootPath, staged]);

  return (
    <div className="ide-diff-overlay">
      <div className="ide-diff-header">
        <span className="ide-diff-title">
          {file}
          <span className={`scm-badge${staged ? "" : " scm-badge-muted"}`}>
            {staged ? "staged" : "unstaged"}
          </span>
        </span>
        <button className="btn btn-icon btn-sm" onClick={onClose} title="Close diff (Esc)">
          <X size={14} />
        </button>
      </div>
      {error && (
        <div className="ide-error">
          {error}
        </div>
      )}
      {!diff && !error && (
        <div className="ide-diff-loading">
          <Loader2 size={16} className="spin" /> Loading diff…
        </div>
      )}
      {diff?.binary && (
        <div className="ide-diff-loading">Binary file — no text diff available.</div>
      )}
      <div ref={containerRef} className="ide-diff-body" />
    </div>
  );
}
