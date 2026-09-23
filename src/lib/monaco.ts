import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import { useThemeStore } from "./theme";
import { onTokensChange, readTokens, toHex } from "./tokens";

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

/** Monaco theme names; both are generated from the design tokens. */
export const AETHER_THEME = "aether-dark";
export const AETHER_LIGHT_THEME = "aether-light";

/** Font stack shared by every Monaco instance. */
export const MONACO_FONT = '"JetBrains Mono Variable", "SF Mono", Menlo, monospace';

/** The Monaco theme matching the active app theme. */
export function currentMonacoTheme(): string {
  return useThemeStore.getState().resolved === "light" ? AETHER_LIGHT_THEME : AETHER_THEME;
}

const MONACO_TOKENS = [
  "--color-bg",
  "--color-overlay",
  "--color-fg-primary",
  "--color-fg-secondary",
  "--color-fg-tertiary",
  "--color-fg-disabled",
  "--color-border",
  "--color-fill-subtle",
  "--color-fill-active",
  "--color-fill-strong",
  "--color-accent",
  "--color-selection",
  "--color-accent-soft",
  "--color-cat-1",
  "--color-cat-2",
  "--color-cat-3",
  "--color-cat-5",
  "--color-cat-6",
] as const;

/**
 * (Re)define the AETHER theme for the *active* app theme from the current
 * token values. Called on setup and whenever the theme or accent changes.
 */
function defineAetherTheme(m: typeof monaco): void {
  const t = readTokens(MONACO_TOKENS);
  const hex = (name: (typeof MONACO_TOKENS)[number]) => toHex(t[name]) || "#808080";
  const bare = (name: (typeof MONACO_TOKENS)[number]) => hex(name).replace("#", "").slice(0, 6);
  const light = useThemeStore.getState().resolved === "light";
  m.editor.defineTheme(light ? AETHER_LIGHT_THEME : AETHER_THEME, {
    base: light ? "vs" : "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: bare("--color-fg-tertiary"), fontStyle: "italic" },
      { token: "keyword", foreground: bare("--color-cat-5") },
      { token: "string", foreground: bare("--color-cat-6") },
      { token: "number", foreground: bare("--color-cat-3") },
      { token: "type", foreground: bare("--color-cat-2") },
      { token: "function", foreground: bare("--color-cat-1") },
      { token: "variable", foreground: bare("--color-fg-primary") },
    ],
    colors: {
      "editor.background": hex("--color-bg"),
      "editor.foreground": hex("--color-fg-primary"),
      "editorLineNumber.foreground": hex("--color-fg-disabled"),
      "editorLineNumber.activeForeground": hex("--color-fg-secondary"),
      "editor.selectionBackground": hex("--color-selection"),
      "editor.lineHighlightBackground": hex("--color-fill-subtle"),
      "editor.lineHighlightBorder": "#00000000",
      "editorCursor.foreground": hex("--color-accent"),
      "editorIndentGuide.background1": hex("--color-fill-active"),
      "editorWidget.background": hex("--color-overlay"),
      "editorWidget.border": hex("--color-border"),
      "editorSuggestWidget.background": hex("--color-overlay"),
      "editorSuggestWidget.border": hex("--color-border"),
      "editorSuggestWidget.selectedBackground": hex("--color-accent-soft"),
      "editorHoverWidget.background": hex("--color-overlay"),
      "editorHoverWidget.border": hex("--color-border"),
      "editorGutter.background": hex("--color-bg"),
      "scrollbarSlider.background": hex("--color-fill-active"),
      "scrollbarSlider.hoverBackground": hex("--color-fill-strong"),
      "minimap.background": hex("--color-bg"),
    },
  });
}

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

  defineAetherTheme(monaco);
  monaco.editor.setTheme(currentMonacoTheme());
  // The bundled mono font can finish loading after the first editor
  // measured its glyphs; re-measure once it is ready.
  if (typeof document !== "undefined" && document.fonts?.load) {
    void document.fonts
      .load(`13px ${MONACO_FONT}`)
      .then(() => monaco.editor.remeasureFonts())
      .catch(() => undefined);
  }
  // Theme / accent switches restyle every open editor in place.
  onTokensChange(() => {
    defineAetherTheme(monaco);
    monaco.editor.setTheme(currentMonacoTheme());
  });

  return monaco;
}

export type { monaco };
