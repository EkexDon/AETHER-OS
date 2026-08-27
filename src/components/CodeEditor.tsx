import { useEffect, useRef } from "react";
import type { editor as MonacoEditor, IDisposable } from "monaco-editor";
import { AETHER_THEME, setupMonaco } from "../lib/monaco";

interface CodeEditorProps {
  /** Identifies the buffer. Switching this swaps the underlying model. */
  path: string;
  value: string;
  language: string;
  onChange: (value: string) => void;
  onSave: () => void;
}

/**
 * A Monaco instance that keeps one model per file path.
 *
 * Reusing models (rather than resetting `value` on every tab switch) is what
 * preserves each file's undo stack, cursor position and scroll offset, which
 * is the behaviour people expect from a real editor.
 */
export function CodeEditor({ path, value, language, onChange, onSave }: CodeEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const modelsRef = useRef(new Map<string, MonacoEditor.ITextModel>());
  const viewStatesRef = useRef(new Map<string, MonacoEditor.ICodeEditorViewState | null>());
  const changeSubRef = useRef<IDisposable | null>(null);

  // Latest callbacks, so the Monaco listeners never close over stale props.
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  useEffect(() => {
    onChangeRef.current = onChange;
    onSaveRef.current = onSave;
  }, [onChange, onSave]);

  // Create the editor once.
  useEffect(() => {
    if (!containerRef.current) return;
    const monaco = setupMonaco();

    const editor = monaco.editor.create(containerRef.current, {
      theme: AETHER_THEME,
      automaticLayout: true,
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'SF Mono', 'Fira Code', Menlo, monospace",
      fontLigatures: true,
      minimap: { enabled: true, maxColumn: 80 },
      scrollBeyondLastLine: false,
      renderWhitespace: "selection",
      smoothScrolling: true,
      cursorBlinking: "smooth",
      tabSize: 2,
      bracketPairColorization: { enabled: true },
      padding: { top: 12, bottom: 12 },
    });
    editorRef.current = editor;

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      onSaveRef.current();
    });

    const models = modelsRef.current;
    return () => {
      changeSubRef.current?.dispose();
      changeSubRef.current = null;
      editor.dispose();
      for (const model of models.values()) model.dispose();
      models.clear();
      editorRef.current = null;
    };
  }, []);

  // Swap the model whenever the active file changes.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const monaco = setupMonaco();

    const previous = editor.getModel();
    if (previous) {
      for (const [key, model] of modelsRef.current) {
        if (model === previous) viewStatesRef.current.set(key, editor.saveViewState());
      }
    }

    let model = modelsRef.current.get(path);
    if (!model || model.isDisposed()) {
      // A file:// URI gives Monaco a stable identity per file and lets the
      // TypeScript worker treat each tab as its own document.
      model = monaco.editor.createModel(value, language, monaco.Uri.file(path));
      modelsRef.current.set(path, model);
    }

    editor.setModel(model);
    const saved = viewStatesRef.current.get(path);
    if (saved) editor.restoreViewState(saved);

    changeSubRef.current?.dispose();
    changeSubRef.current = model.onDidChangeContent(() => {
      onChangeRef.current(model.getValue());
    });

    editor.focus();
  }, [path, language]);

  // Adopt external content changes (e.g. a reload from disk) without
  // disturbing the cursor when the buffer already matches.
  useEffect(() => {
    const model = modelsRef.current.get(path);
    if (model && !model.isDisposed() && model.getValue() !== value) {
      model.setValue(value);
    }
  }, [path, value]);

  return <div ref={containerRef} className="code-editor" />;
}
