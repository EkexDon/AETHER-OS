import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

/**
 * Monaco is wired up entirely from the local bundle — no CDN loader — so the
 * editor keeps working with no network, which is a hard requirement for a
 * local-first desktop app.
 */
declare global {
  interface Window {
    MonacoEnvironment?: monaco.Environment;
  }
}

let configured = false;

export const AETHER_THEME = "aether-dark";

export function setupMonaco(): typeof monaco {
  if (configured) return monaco;
  configured = true;

  window.MonacoEnvironment = {
    getWorker(_workerId: string, label: string) {
      switch (label) {
        case "json":
          return new jsonWorker();
        case "css":
        case "scss":
        case "less":
          return new cssWorker();
        case "html":
        case "handlebars":
        case "razor":
          return new htmlWorker();
        case "typescript":
        case "javascript":
          return new tsWorker();
        default:
          return new editorWorker();
      }
    },
  };

  // We open individual files, not whole typed projects, so the TS worker has
  // no module graph to resolve against. Semantic validation would therefore
  // flood every import with false "cannot find module" errors. Syntax
  // validation stays on, since that is accurate for a single file.
  for (const defaults of [
    monaco.languages.typescript.typescriptDefaults,
    monaco.languages.typescript.javascriptDefaults,
  ]) {
    defaults.setDiagnosticsOptions({
      noSemanticValidation: true,
      noSyntaxValidation: false,
    });
    defaults.setCompilerOptions({
      target: monaco.languages.typescript.ScriptTarget.ES2020,
      module: monaco.languages.typescript.ModuleKind.ESNext,
      moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
      jsx: monaco.languages.typescript.JsxEmit.ReactJSX,
      allowNonTsExtensions: true,
      allowJs: true,
    });
  }

  monaco.editor.defineTheme(AETHER_THEME, {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: "6b6b78", fontStyle: "italic" },
      { token: "keyword", foreground: "c084fc" },
      { token: "string", foreground: "86efac" },
      { token: "number", foreground: "fbbf24" },
      { token: "type", foreground: "67e8f9" },
      { token: "function", foreground: "93c5fd" },
      { token: "variable", foreground: "e4e4e8" },
    ],
    colors: {
      "editor.background": "#0a0a0c",
      "editor.foreground": "#e4e4e8",
      "editorLineNumber.foreground": "#3a3a44",
      "editorLineNumber.activeForeground": "#8b8b9a",
      "editor.selectionBackground": "#6b6bf540",
      "editor.lineHighlightBackground": "#ffffff08",
      "editorCursor.foreground": "#6b6bf5",
      "editorIndentGuide.background1": "#ffffff10",
      "editorWidget.background": "#14141a",
      "editorWidget.border": "#ffffff18",
      "editorSuggestWidget.background": "#14141a",
      "editorSuggestWidget.selectedBackground": "#6b6bf533",
      "editorGutter.background": "#0a0a0c",
      "scrollbarSlider.background": "#ffffff14",
      "scrollbarSlider.hoverBackground": "#ffffff22",
    },
  });

  return monaco;
}

export type { monaco };
