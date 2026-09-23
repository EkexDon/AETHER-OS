/** Note editing commands (`src-tauri/src/commands/note_commands.rs`). */
import type { AgentAction, Backlink, ClippedPage } from "../../types";
import { call } from "./core";

/** Overwrite a note (absolute path inside the vault). */
export const writeNote = (path: string, content: string) =>
  call<void>("cmd_write_note", { path, content });
/** Create a note at a vault-relative path; returns the absolute path (never clobbers). */
export const createNote = (relPath: string, content: string) =>
  call<string>("cmd_create_note", { relPath, content });
/** Append content (plus newline) to a note. */
export const appendNote = (path: string, content: string) =>
  call<void>("cmd_append_note", { path, content });
/** Notes linking to `noteName` via `[[wikilinks]]`. */
export const getBacklinks = (noteName: string) =>
  call<Backlink[]>("cmd_get_backlinks", { noteName });
/** Today's daily note path (Settings → Vault layout, default `daily/YYYY-MM-DD.md`), created if missing. */
export const dailyNote = () => call<string>("cmd_daily_note");
/** Append a timestamped bullet to today's daily note; returns its path. */
export const appendDaily = (text: string) => call<string>("cmd_append_daily", { text });
/** Fetch a web page and extract its readable content. */
export const clipUrl = (url: string) => call<ClippedPage>("cmd_clip_url", { url });
/** Execute a vault-only agent action; returns a status line. */
export const executeAgentAction = (action: AgentAction) =>
  call<string>("cmd_execute_agent_action", { action });
