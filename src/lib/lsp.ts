/**
 * lsp — Language Server Protocol plumbing for the IDE.
 *
 * The Rust side (`engine/lsp.rs`) owns the server processes and the stdio
 * framing; this module speaks JSON-RPC to them over Tauri IPC and maps the
 * handful of LSP features Monaco needs onto its provider APIs:
 *
 *   hover · completions · go-to-definition · publishDiagnostics
 *
 * Everything here follows the official protocol types
 * (https://microsoft.github.io/language-server-protocol/specification).
 */

import type { IDisposable } from "monaco-editor";
import { lspSend } from "./ipc";

/** One server instance, identified exactly like the backend keys it. */
export function sessionKey(language: string, root: string): string {
  return `${language}::${root}`;
}

// ── URI helpers ──────────────────────────────────────────────

/** `/Users/x/my file.ts` → `file:///Users/x/my%20file.ts` */
export function pathToUri(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/^\//, "");
  return `file:///${normalized.split("/").map(encodeURIComponent).join("/")}`;
}

/** Inverse of {@link pathToUri}; tolerant of non-file schemes (returns as-is). */
export function uriToPath(uri: string): string {
  if (!uri.startsWith("file://")) return uri;
  const rest = uri.slice("file://".length);
  const decoded = rest
    .split("/")
    .map(decodeURIComponent)
    .join("/");
  // file:///a/b has an empty authority segment → leading slash.
  return decoded.startsWith("//") ? decoded.slice(1) : decoded;
}

// ── Position math ────────────────────────────────────────────
// LSP positions are zero-based line/character pairs where `character` counts
// UTF-16 code units — the exact unit JavaScript strings use natively, so no
// surrogate-pair gymnastics are needed.

export interface LspPosition {
  line: number;
  character: number;
}

export function offsetToPosition(text: string, offset: number): LspPosition {
  const clamped = Math.max(0, Math.min(offset, text.length));
  let line = 0;
  let lastNewline = -1;
  for (let i = 0; i < clamped; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) {
      line++;
      lastNewline = i;
    }
  }
  return { line, character: clamped - lastNewline - 1 };
}

export function positionToOffset(text: string, pos: LspPosition): number {
  if (pos.line <= 0) return Math.max(0, Math.min(pos.character, text.length));
  let line = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      if (line === pos.line) {
        const lineStart = i + 1;
        const lineEnd = text.indexOf("\n", lineStart);
        const limit = lineEnd === -1 ? text.length : lineEnd;
        return lineStart + Math.max(0, Math.min(pos.character, limit - lineStart));
      }
    }
  }
  return text.length; // line beyond EOF
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

/** LSP ranges are zero-based; Monaco's are one-based. */
export function toMonacoRange(range?: LspRange): {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
} {
  const start = range?.start ?? { line: 0, character: 0 };
  const end = range?.end ?? { line: 0, character: 0 };
  return {
    startLineNumber: start.line + 1,
    startColumn: start.character + 1,
    endLineNumber: end.line + 1,
    endColumn: end.character + 1,
  };
}

/** LSP Diagnostic severities (1=Error … 4=Hint) → Monaco marker severities. */
export function toMarkerSeverity(lspSeverity?: number): number {
  switch (lspSeverity) {
    case 1:
      return 8; // monaco.MarkerSeverity.Error
    case 2:
      return 4; // Warning
    case 3:
      return 2; // Info
    case 4:
      return 1; // Hint
    default:
      return 8;
  }
}

// ── JSON-RPC connection ──────────────────────────────────────

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

/**
 * A thin JSON-RPC 2.0 peer. Incoming messages are routed here by
 * {@link routeLspMessage}, which the global Tauri listener calls once.
 */
export class LspConnection {
  readonly key: string;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private notificationHandlers = new Set<(message: Record<string, unknown>) => void>();
  private requestHandlers = new Map<
    string,
    (message: Record<string, unknown>) => Promise<unknown>
  >();
  /** Fired when the backend reports the server process died. */
  onClose: (() => void) | null = null;

  constructor(key: string) {
    this.key = key;
  }

  sendRequest(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      lspSend(this.key, { jsonrpc: "2.0", id, method, params }).catch(reject);
    });
  }

  notify(method: string, params: unknown): void {
    lspSend(this.key, { jsonrpc: "2.0", method, params }).catch((e) =>
      console.warn("[lsp] notify failed:", method, e)
    );
  }

  onNotification(handler: (message: Record<string, unknown>) => void): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  onRequest(
    method: string,
    handler: (message: Record<string, unknown>) => Promise<unknown>
  ): void {
    this.requestHandlers.set(method, handler);
  }

  /** Entry point for every message the backend forwards from this server. */
  handleMessage(message: Record<string, unknown>): void {
    // Synthetic backend signal: the process exited.
    if ("aetherServerExit" in message) {
      this.pending.forEach(({ reject }) =>
        reject(new Error("language server exited"))
      );
      this.pending.clear();
      this.onClose?.();
      return;
    }

    const id = message.id as number | string | null | undefined;
    if (id !== undefined && id !== null && ("method" in message)) {
      // Server → client request; answer so servers never hang.
      const method = message.method as string;
      const handler = this.requestHandlers.get(method);
      if (handler) {
        handler(message)
          .then((result) => {
            this.reply(id, result);
          })
          .catch((e: unknown) => {
            this.replyError(id, e instanceof Error ? e.message : String(e));
          });
      } else {
        this.replyError(id, `method not supported: ${method}`);
        console.debug("[lsp] unhandled server request:", method);
      }
      return;
    }

    if (id !== undefined && id !== null && ("result" in message || "error" in message)) {
      const entry = this.pending.get(Number(id));
      if (!entry) return;
      this.pending.delete(Number(id));
      if ("error" in message) {
        const err = message.error as { message?: string } | null;
        entry.reject(new Error(err?.message ?? "server error"));
      } else {
        entry.resolve(message.result);
      }
      return;
    }

    if ("method" in message) {
      this.notificationHandlers.forEach((h) => h(message));
    }
  }

  private reply(id: number | string, result: unknown): void {
    lspSend(this.key, { jsonrpc: "2.0", id, result }).catch(() => undefined);
  }

  private replyError(id: number | string, message: string): void {
    lspSend(this.key, {
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message },
    }).catch(() => undefined);
  }
}

const connections = new Map<string, LspConnection>();

/** Get (or lazily create) the connection object for a backend session key. */
export function getConnection(key: string): LspConnection {
  let conn = connections.get(key);
  if (!conn) {
    conn = new LspConnection(key);
    connections.set(key, conn);
  }
  return conn;
}

/** Drop the local handle after the backend stopped the process. */
export function removeConnection(key: string): void {
  connections.delete(key);
}

/** Called by the single global Tauri event listener. */
export function routeLspMessage(payload: { key: string; message: unknown }): void {
  const conn = connections.get(payload.key);
  if (conn) {
    conn.handleMessage(payload.message as Record<string, unknown>);
  }
}

export interface DisposableSession {
  dispose: () => void;
  capabilities: unknown;
}

/** Collect disposables so tests can assert cleanup semantics. */
export function combineDisposables(...items: (IDisposable | (() => void))[]): () => void {
  return () => {
    for (const item of items) {
      if (typeof item === "function") item();
      else item.dispose();
    }
  };
}
