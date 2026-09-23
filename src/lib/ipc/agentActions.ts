/** Agent action router commands (`src-tauri/src/commands/agent_action_commands.rs`)
 *  plus the calendar variants the agent routes to the calendar commands. */
import type { AgentActionResult, CalendarEventPatch } from "../../types";
import { calendarEventArgs, type CalendarEventInput } from "./calendar";
import { call } from "./core";

export type {
  AgentActionResult,
  AgentActionResultAether,
  AgentActionResultCalendarCreated,
  AgentActionResultCalendarDeleted,
  AgentActionResultCalendarImported,
  AgentActionResultCalendarListed,
  AgentActionResultCalendarUpdated,
  AgentActionResultClipped,
  AgentActionResultFact,
  AgentActionResultOpened,
} from "../../types";

/** `open_url`: open in the system browser. */
export const agentOpenUrl = (url: string) =>
  call<AgentActionResult>("cmd_agent_open_url", { url });
/** `clip_url`: fetch a page; the frontend converts and saves it. */
export const agentClipUrl = (url: string) =>
  call<AgentActionResult>("cmd_agent_clip_url", { url });
/** `add_memory_fact`: persist a fact. */
export const agentAddMemoryFact = (fact: string, category: string) =>
  call<AgentActionResult>("cmd_agent_add_memory_fact", { fact, category });
/** `save_aether_note`: save to the AETHER Notes library. */
export const agentSaveAetherNote = (title: string, content: string) =>
  call<AgentActionResult>("cmd_agent_save_aether_note", { title, content });
/** `create_calendar_event` (routes to `cmd_create_calendar_event`). */
export const agentCreateCalendarEvent = (input: CalendarEventInput) =>
  call<AgentActionResult>("cmd_create_calendar_event", calendarEventArgs(input));
/** `update_calendar_event` (routes to `cmd_update_calendar_event`). */
export const agentUpdateCalendarEvent = (id: string, patch: CalendarEventPatch) =>
  call<AgentActionResult>("cmd_update_calendar_event", { id, patch });
/** `delete_calendar_event` (routes to `cmd_delete_calendar_event`). */
export const agentDeleteCalendarEvent = (id: string) =>
  call<AgentActionResult>("cmd_delete_calendar_event", { id });
/** `list_calendar_events` (routes to `cmd_list_calendar_events`). */
export const agentListCalendarEvents = (from: string | null, to: string | null) =>
  call<AgentActionResult>("cmd_list_calendar_events", { from, to });
/** `import_calendar_ics` (routes to `cmd_import_calendar_ics`). */
export const agentImportCalendarIcs = (path: string, overwriteExisting: boolean, defaultColor: string) =>
  call<AgentActionResult>("cmd_import_calendar_ics", { path, overwriteExisting, defaultColor });
