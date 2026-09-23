/**
 * Execute one agent action: route it to the right IPC command, apply the
 * side effects to the app stores (vault list, open note, calendar, task
 * board) and make sure it lands in the audit log.
 *
 * The `cmd_intel_*` commands audit themselves in Rust; everything routed
 * through other commands is recorded here with `cmd_intel_audit_record`
 * right after it ran (best effort — an audit failure never hides the
 * action's own result).
 */
import type { AgentAction, CalendarEvent, CalendarEventPatch, CommandOutput } from "../../types";
import {
  agentAddMemoryFact,
  agentClipUrl,
  agentOpenUrl,
  agentSaveAetherNote,
  createCalendarEvent,
  createNote,
  deleteCalendarEvent,
  executeAgentAction,
  getAetherNotes,
  getVaultNotes,
  importCalendarIcs,
  intelCreateTask,
  intelDeleteNote,
  intelGitCommit,
  intelMoveNote,
  intelRunCommand,
  intelToggleVaultTask,
  listCalendarEvents,
  readIcsFromPath,
  recordAgentAudit,
  updateCalendarEvent,
} from "../ipc";
import { useAetherStore } from "../store";
import { buildClipNote, clipNoteName } from "../clipper";
import { DEFAULT_CALENDAR_COLOR } from "../calendarColors";
import { reloadOpenNote, waitForCleanNote } from "./noteEdits";

/** What an executed action reports back to the chat. */
export interface ActionOutcome {
  /** One line for the result chip. */
  message: string;
  /** Shell output of `run_command`. */
  output?: CommandOutput;
}

/** Kinds executed (and audited) by `cmd_intel_*` commands. */
export const RUST_AUDITED_KINDS: ReadonlySet<AgentAction["action"]> = new Set([
  "run_command",
  "delete_note",
  "move_note",
  "git_commit",
  "create_task",
  "toggle_vault_task",
]);

async function refreshVaultNotes(): Promise<void> {
  const notes = await getVaultNotes();
  useAetherStore.getState().setVaultNotes(notes);
}

/** The absolute path of the note being edited, when an action targets it by name or path. */
function openNoteMatching(target: string): string | null {
  const selected = useAetherStore.getState().selectedNotePath;
  if (!selected) return null;
  const t = target.trim().replace(/\\/g, "/").replace(/\.md$/i, "").toLowerCase();
  const s = selected.replace(/\\/g, "/").replace(/\.md$/i, "").toLowerCase();
  if (!t) return null;
  return s === t || s.endsWith(`/${t}`) ? selected : null;
}

function withinRange(event: CalendarEvent, from: string | null, to: string | null): boolean {
  const start = event.start.slice(0, 10);
  const end = (event.end || event.start).slice(0, 10);
  if (from && end < from.slice(0, 10)) return false;
  if (to && start > to.slice(0, 10)) return false;
  return true;
}

async function route(action: AgentAction): Promise<ActionOutcome> {
  const store = useAetherStore.getState();
  switch (action.action) {
    case "create_note":
    case "append_daily": {
      const message = await executeAgentAction(action);
      await refreshVaultNotes();
      if (action.action === "append_daily") {
        const selected = store.selectedNotePath;
        if (selected && /[\\/]daily[\\/]\d{4}-\d{2}-\d{2}\.md$/.test(selected)) await reloadOpenNote(selected);
      }
      return { message };
    }
    case "append_note": {
      const open = openNoteMatching(action.path);
      if (open) await waitForCleanNote(open);
      const message = await executeAgentAction(action);
      await refreshVaultNotes();
      if (open) await reloadOpenNote(open);
      return { message };
    }
    case "add_memory_fact": {
      const result = await agentAddMemoryFact(action.fact, action.category);
      return { message: result.kind === "fact_saved" ? `Remembered: "${action.fact}"` : "Fact saved" };
    }
    case "save_aether_note": {
      await agentSaveAetherNote(action.title, action.content);
      store.setAetherNotes(await getAetherNotes());
      return { message: `Saved to AETHER Notes: "${action.title}"` };
    }
    case "open_url": {
      await agentOpenUrl(action.url);
      return { message: `Opened ${action.url}` };
    }
    case "clip_url": {
      // The backend fetches the HTML; turndown (a JS dependency) converts it.
      const result = await agentClipUrl(action.url);
      if (result.kind !== "clipped_page") throw new Error("The page could not be clipped.");
      const now = new Date();
      const created = await createNote(`clips/${clipNoteName(result.path.title, now)}`, buildClipNote(result.path, now));
      await refreshVaultNotes();
      return { message: `Clipped to ${created}` };
    }
    case "create_calendar_event": {
      const event = await createCalendarEvent({
        title: action.title,
        description: action.description ?? "",
        all_day: action.all_day,
        start: action.start,
        end: action.end,
        due: action.due ?? null,
        color: action.color ?? DEFAULT_CALENDAR_COLOR,
        tags: action.tags ?? [],
        attendees: action.attendees ?? [],
        location: action.location ?? null,
        source_note_path: null,
      });
      store.upsertCalendarEvent(event);
      return { message: `Created event "${event.title}"` };
    }
    case "update_calendar_event": {
      const patch: CalendarEventPatch = {};
      if (action.title != null) patch.title = action.title;
      if (action.description != null) patch.description = action.description;
      if (action.all_day != null) patch.all_day = action.all_day;
      if (action.start != null) patch.start = action.start;
      if (action.end != null) patch.end = action.end;
      if (action.due != null) patch.due = action.due;
      if (action.color != null) patch.color = action.color;
      if (action.tags != null) patch.tags = action.tags;
      if (action.attendees != null) patch.attendees = action.attendees;
      if (action.location != null) patch.location = action.location;
      const event = await updateCalendarEvent(action.id, patch);
      store.upsertCalendarEvent(event);
      return { message: `Updated event "${event.title}"` };
    }
    case "delete_calendar_event": {
      await deleteCalendarEvent(action.id);
      store.removeCalendarEvent(action.id);
      return { message: `Deleted event ${action.id}` };
    }
    case "list_calendar_events": {
      const events = (await listCalendarEvents()).filter((e) => withinRange(e, action.from ?? null, action.to ?? null));
      return { message: `Found ${events.length} event${events.length === 1 ? "" : "s"}` };
    }
    case "import_calendar_ics": {
      const content = await readIcsFromPath(action.path);
      const r = await importCalendarIcs(content, action.overwrite_existing, action.default_color ?? DEFAULT_CALENDAR_COLOR);
      store.setCalendarEvents(await listCalendarEvents());
      return { message: `Imported: ${r.added} added, ${r.updated} updated, ${r.skipped} skipped` };
    }
    case "run_command": {
      const output = await intelRunCommand(action.command, action.cwd ?? null);
      const where = output.cwd.split(/[\\/]/).filter(Boolean).pop() ?? output.cwd;
      const message = output.timed_out
        ? `Timed out in ${where}`
        : output.exit_code === 0
          ? `Ran in ${where}`
          : output.exit_code === null
            ? `Stopped in ${where}`
            : `Exited with code ${output.exit_code} in ${where}`;
      return { message, output };
    }
    case "delete_note": {
      const open = openNoteMatching(action.path);
      if (open) await waitForCleanNote(open);
      const trashed = await intelDeleteNote(action.path);
      const s = useAetherStore.getState();
      if (s.openNoteTabs.includes(trashed.original_path)) s.closeNoteTab(trashed.original_path);
      if (open && open !== trashed.original_path && s.openNoteTabs.includes(open)) s.closeNoteTab(open);
      await refreshVaultNotes();
      return { message: `Moved to trash: ${trashed.trash_path.split(/[\\/]/).pop() ?? trashed.trash_path}` };
    }
    case "move_note": {
      const open = openNoteMatching(action.from);
      if (open) await waitForCleanNote(open);
      const moved = await intelMoveNote(action.from, action.to);
      const s = useAetherStore.getState();
      const wasSelected = s.selectedNotePath === moved.from || (open !== null && s.selectedNotePath === open);
      if (s.openNoteTabs.includes(moved.from)) s.closeNoteTab(moved.from);
      if (open && s.openNoteTabs.includes(open)) s.closeNoteTab(open);
      await refreshVaultNotes();
      if (wasSelected) useAetherStore.getState().selectNote(moved.to);
      return { message: `Moved to ${moved.to}` };
    }
    case "git_commit": {
      const commit = await intelGitCommit(action.project_path, action.message);
      return {
        message: `Committed ${commit.commit_id.slice(0, 7)} on ${commit.branch} (${commit.files.length} file${commit.files.length === 1 ? "" : "s"})`,
      };
    }
    case "create_task": {
      const created = await intelCreateTask({
        projectId: action.project_id ?? null,
        title: action.title,
        description: action.description ?? null,
        priority: action.priority ?? null,
        dueDate: action.due_date ?? null,
      });
      const s = useAetherStore.getState();
      if (created.created_project) s.upsertTaskProject(created.project);
      if (s.selectedProjectId === created.project.id) s.upsertTaskItem(created.task);
      return { message: `Task "${created.task.title}" added to ${created.project.name}` };
    }
    case "toggle_vault_task": {
      const open = openNoteMatching(action.note_path);
      if (open) await waitForCleanNote(open);
      const toggled = await intelToggleVaultTask(action.note_path, action.line);
      await reloadOpenNote(toggled.path);
      return { message: `${toggled.checked ? "Checked" : "Unchecked"} "${toggled.text}"` };
    }
  }
}

/**
 * Run an (already approved) action. Resolves with its outcome or rejects
 * with a readable error; either way the action is in the audit log.
 */
export async function runAgentAction(action: AgentAction): Promise<ActionOutcome> {
  const auditHere = !RUST_AUDITED_KINDS.has(action.action);
  try {
    const outcome = await route(action);
    if (auditHere) void recordAgentAudit(action, "ok", outcome.message).catch(() => undefined);
    return outcome;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (auditHere) void recordAgentAudit(action, "error", message).catch(() => undefined);
    throw new Error(message);
  }
}

/** Record that the user denied an action (best effort). */
export function recordDenied(action: AgentAction): void {
  void recordAgentAudit(action, "denied", null).catch(() => undefined);
}
