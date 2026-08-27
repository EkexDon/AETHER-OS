/**
 * lspMonaco — wires one language server session into Monaco.
 *
 * Handles the full LSP lifecycle the backend deliberately knows nothing
 * about: initialize handshake, document sync (full-text, debounced),
 * provider registration (hover, completion, definition) and diagnostics →
 * markers. Servers are found on PATH by the backend; when none exists this
 * module simply never activates and Monaco keeps its built-in features.
 */

import { Uri } from "monaco-editor";
import type { editor as MonacoEditor, IDisposable, languages } from "monaco-editor";
import {
  combineDisposables,
  getConnection,
  pathToUri,
  removeConnection,
  toMarkerSeverity,
  toMonacoRange,
  uriToPath,
} from "./lsp";
import { onLspMessage, lspStart, lspStop } from "./ipc";

export type LspStatus = "starting" | "ready" | "unavailable" | "error";

interface SessionOptions {
  rootPath: string;
  languageId: string;
  monaco: typeof import("monaco-editor");
  onStatus: (status: LspStatus) => void;
}

/** Debounce for didChange notifications — servers prefer fewer, larger syncs. */
const SYNC_DEBOUNCE_MS = 250;

let globalListenerAttached = false;

async function attachGlobalListener(): Promise<() => void> {
  if (!globalListenerAttached) {
    globalListenerAttached = true;
    // Imported lazily to avoid a cycle: ipc ← lsp ← lspMonaco is fine, but we
    // also want routeLspMessage without importing lsp.ts here twice.
    const { routeLspMessage } = await import("./lsp");
    return onLspMessage((payload) => routeLspMessage(payload));
  }
  return () => undefined;
}

/**
 * Start a language server for `languageId` under `rootPath` and hook it into
 * Monaco. Resolves with a disposer once the handshake finished ("ready"), or
 * with `null` when no server is installed for this language.
 */
export async function connectLanguage(options: SessionOptions): Promise<(() => void) | null> {
  const { rootPath, languageId, monaco, onStatus } = options;
  onStatus("starting");

  let info;
  try {
    info = await lspStart(rootPath, languageId);
  } catch (e) {
    console.warn("[lsp] start failed:", e);
    onStatus("unavailable");
    return null;
  }
  // No server binary for this language on PATH — stay silent, that's normal.
  if (!info) {
    onStatus("unavailable");
    return null;
  }

  const detachListenerPromise = attachGlobalListener();
  const conn = getConnection(info.key);

  let disposed = false;
  const disposables: (IDisposable | (() => void))[] = [];
  disposables.push(() => void detachListenerPromise.then((fn) => fn()));

  conn.onClose = () => {
    if (!disposed) onStatus("error");
  };

  try {
    const capabilities = await conn.sendRequest("initialize", {
      processId: null,
      rootUri: pathToUri(rootPath),
      workspaceFolders: [
        { uri: pathToUri(rootPath), name: rootPath.split("/").pop() ?? rootPath },
      ],
      capabilities: {
        textDocument: {
          synchronization: { dynamicRegistration: false, didSave: false },
          completion: {
            completionItem: { snippetSupport: true, documentationFormat: ["markdown", "plaintext"] },
          },
          hover: { contentFormat: ["markdown", "plaintext"] },
        },
        workspace: { configuration: false, workspaceFolders: false },
      },
    });
    if (disposed) return () => undefined;
    conn.notify("initialized", {});
    onStatus("ready");

    // ── Document sync ────────────────────────────────────────
    const syncedUris = new Set<string>();
    const changeTimers = new Map<string, number>();

    const openDocument = (model: MonacoEditor.ITextModel) => {
      const path = model.uri.fsPath;
      if (!path.startsWith(rootPath) || model.getLanguageId() !== languageId) return;
      if (syncedUris.has(model.uri.toString())) return;
      syncedUris.add(model.uri.toString());
      conn.notify("textDocument/didOpen", {
        textDocument: {
          uri: pathToUri(path),
          languageId,
          version: model.getVersionId(),
          text: model.getValue(),
        },
      });
    };

    const closeDocument = (model: MonacoEditor.ITextModel) => {
      if (!syncedUris.delete(model.uri.toString())) return;
      conn.notify("textDocument/didClose", {
        textDocument: { uri: pathToUri(model.uri.fsPath) },
      });
      const timer = changeTimers.get(model.uri.toString());
      if (timer !== undefined) window.clearTimeout(timer);
      changeTimers.delete(model.uri.toString());
    };

    for (const model of monaco.editor.getModels()) openDocument(model);
    disposables.push(monaco.editor.onDidCreateModel(openDocument));
    disposables.push(monaco.editor.onWillDisposeModel(closeDocument));

    // Per-model listeners are exact: each synced document gets its own
    // debounced didChange stream.
    const attachChangeListener = (model: MonacoEditor.ITextModel) => {
      openDocument(model);
      disposables.push(
        model.onDidChangeContent(() => {
          const key = model.uri.toString();
          const existing = changeTimers.get(key);
          if (existing !== undefined) window.clearTimeout(existing);
          changeTimers.set(
            key,
            window.setTimeout(() => {
              changeTimers.delete(key);
              conn.notify("textDocument/didChange", {
                textDocument: { uri: pathToUri(model.uri.fsPath), version: model.getVersionId() },
                contentChanges: [{ text: model.getValue() }],
              });
            }, SYNC_DEBOUNCE_MS)
          );
        })
      );
    };
    for (const model of monaco.editor.getModels()) attachChangeListener(model);
    disposables.push(monaco.editor.onDidCreateModel(attachChangeListener));

    disposables.push({
      dispose: () => {
        for (const model of monaco.editor.getModels()) closeDocument(model);
      },
    });

    // ── Diagnostics → markers ────────────────────────────────
    disposables.push(
      conn.onNotification((message) => {
        if (message.method === "textDocument/publishDiagnostics") {
          const params = message.params as {
            uri: string;
            diagnostics?: Array<{
              range: Parameters<typeof toMonacoRange>[0];
              message: string;
              severity?: number;
              source?: string;
              code?: number | string;
            }>;
          } | undefined;
          if (!params) return;
          const path = uriToPath(params.uri);
          const model = monaco.editor.getModels().find((m) => m.uri.fsPath === path);
          if (!model) return;
          const markers: MonacoEditor.IMarkerData[] = (params.diagnostics ?? []).map((d) => ({
            ...toMonacoRange(d.range),
            message: d.message,
            severity: toMarkerSeverity(d.severity),
            source: d.source ?? "lsp",
          }));
          monaco.editor.setModelMarkers(model, "lsp", markers);
        }
      })
    );

    // ── Providers ────────────────────────────────────────────
    const appliesTo = (model: MonacoEditor.ITextModel) =>
      syncedUris.has(model.uri.toString());

    disposables.push(
      monaco.languages.registerHoverProvider(languageId, {
        async provideHover(model, position) {
          if (!appliesTo(model)) return null;
          const result = (await conn.sendRequest("textDocument/hover", {
            textDocument: { uri: pathToUri(model.uri.fsPath) },
            position: { line: position.lineNumber - 1, character: position.column - 1 },
          })) as {
            contents?:
              | { kind?: string; value?: string }
              | Array<{ value?: string } | string>
              | string;
            range?: Parameters<typeof toMonacoRange>[0];
          } | null;
          if (!result) return null;
          return {
            range: toMonacoRange(result.range),
            contents: normalizeHoverContents(result.contents),
          };
        },
      }) satisfies IDisposable
    );

    disposables.push(
      monaco.languages.registerCompletionItemProvider(languageId, {
        triggerCharacters: [".", "/", '"', "'", "<", ":"],
        async provideCompletionItems(model, position) {
          if (!appliesTo(model)) return { suggestions: [] };
          const word = model.getWordUntilPosition(position);
          const result = (await conn.sendRequest("textDocument/completion", {
            textDocument: { uri: pathToUri(model.uri.fsPath) },
            position: { line: position.lineNumber - 1, character: position.column - 1 },
          })) as
            | Array<LspCompletionItem>
            | { items?: LspCompletionItem[] }
            | null;
          const items = Array.isArray(result) ? result : (result?.items ?? []);
          const suggestions: languages.CompletionItem[] = items.map((item) =>
            mapCompletionItem(item, word, position.lineNumber)
          );
          return { suggestions };
        },
      }) satisfies IDisposable
    );

    disposables.push(
      monaco.languages.registerDefinitionProvider(languageId, {
        async provideDefinition(model, position) {
          if (!appliesTo(model)) return null;
          const result = (await conn.sendRequest("textDocument/definition", {
            textDocument: { uri: pathToUri(model.uri.fsPath) },
            position: { line: position.lineNumber - 1, character: position.column - 1 },
          })) as
            | { uri: string; range?: Parameters<typeof toMonacoRange>[0] }
            | Array<{ uri: string; range?: Parameters<typeof toMonacoRange>[0] }>
            | null;
          const first = Array.isArray(result) ? result[0] : result;
          if (!first) return null;
          return {
            uri: Uri.file(uriToPath(first.uri)),
            range: toMonacoRange(first.range),
          };
        },
      }) satisfies IDisposable
    );

    // ── Server → client requests we must answer ─────────────
    conn.onRequest("workspace/configuration", async () => [null]);
    conn.onRequest("client/registerCapability", async () => null);
    conn.onRequest("window/workDoneProgress/create", async () => null);

    const disposeAll = combineDisposables(...disposables);
    return () => {
      disposed = true;
      disposeAll();
      void lspStop(info!.key).finally(() => removeConnection(info!.key));
    };
  } catch (e) {
    console.warn("[lsp] initialization failed:", e);
    onStatus("error");
    void lspStop(info.key).finally(() => removeConnection(info.key));
    return null;
  }
}

// ── Mapping helpers (kept here so they stay next to their call sites) ──

interface LspCompletionItem {
  label: string | { label: string; detail?: string };
  insertText?: string;
  insertTextFormat?: 1 | 2; // 2 = snippet
  detail?: string;
  documentation?: string | { kind?: string; value?: string };
  kind?: number;
  sortText?: string;
  filterText?: string;
  deprecated?: boolean;
  preselect?: boolean;
}

/** LSP CompletionItemKind values align with Monaco's numeric enum. */
function mapCompletionItemKind(kind?: number): languages.CompletionItemKind {
  const known = new Set([
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25,
  ]);
  if (kind && known.has(kind)) return kind as languages.CompletionItemKind;
  return 1 as languages.CompletionItemKind; // Text — safe default
}

function mapCompletionItem(
  item: LspCompletionItem,
  word: { startColumn: number; endColumn: number },
  lineNumber: number
): languages.CompletionItem {
  const label = typeof item.label === "string" ? item.label : item.label.label;
  const insertText = item.insertText ?? label;
  const doc = item.documentation;
  return {
    label,
    kind: mapCompletionItemKind(item.kind),
    detail:
      typeof item.label === "string" ? item.detail : (item.label.detail ?? item.detail),
    insertText,
    insertTextRules: item.insertTextFormat === 2 ? 4 : undefined, // InsertAsSnippet
    documentation: typeof doc === "string" ? doc : doc?.value,
    sortText: item.sortText,
    filterText: item.filterText,
    range: {
      startLineNumber: lineNumber,
      endLineNumber: lineNumber,
      startColumn: word.startColumn,
      endColumn: word.endColumn,
    },
  };
}

function normalizeHoverContents(
  contents: unknown
): Array<{ value: string }> {
  if (typeof contents === "string") return [{ value: contents }];
  if (Array.isArray(contents)) {
    return contents.map((entry) =>
      typeof entry === "string"
        ? { value: entry }
        : { value: (entry as { value?: string }).value ?? "" }
    );
  }
  const single = contents as { kind?: string; value?: string } | null;
  if (single?.value !== undefined) {
    // Plaintext hover reads better fenced so line breaks survive.
    return single.kind === "plaintext"
      ? [{ value: "```\n" + single.value + "\n```" }]
      : [{ value: single.value }];
  }
  return [];
}
