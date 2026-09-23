/** Agent action types — mirror `engine/agent_actions.rs` and
 *  `commands/agent_action_commands.rs`. */

import type { CalendarEvent, IcsImportResult } from "./calendar";
import type { ClippedPage } from "./notes";

/** An action the AI emits in a fenced ```action block. */
export type AgentAction =
  | { action: "create_note"; title: string; content: string }
  | { action: "append_note"; path: string; content: string }
  | { action: "append_daily"; content: string }
  | { action: "open_url"; url: string }
  | { action: "clip_url"; url: string }
  | { action: "add_memory_fact"; fact: string; category: string }
  | { action: "save_aether_note"; title: string; content: string }
  | { action: "create_calendar_event"; title: string; description: string; all_day: boolean; start: string; end: string; due: string | null; color: string | null; tags: string[]; attendees: string[]; location: string | null }
  | { action: "update_calendar_event"; id: string; title: string | null; description: string | null; all_day: boolean | null; start: string | null; end: string | null; due: string | null; color: string | null; tags: string[] | null; attendees: string[] | null; location: string | null }
  | { action: "delete_calendar_event"; id: string }
  | { action: "list_calendar_events"; from: string | null; to: string | null }
  | { action: "import_calendar_ics"; path: string; overwrite_existing: boolean; default_color: string | null };

/** `open_url` succeeded — the URL is open in the system browser. */
export interface AgentActionResultOpened { kind: "opened"; url: string }
/** `clip_url` returned the extracted page; the frontend writes the note. */
export interface AgentActionResultClipped { kind: "clipped_page"; path: ClippedPage }
/** `add_memory_fact` succeeded. */
export interface AgentActionResultFact { kind: "fact_saved"; fact: { id: string; fact: string; category: string; created_at: number } }
/** `save_aether_note` succeeded. */
export interface AgentActionResultAether { kind: "aether_note_saved"; note: { id: string; title: string; content: string; created_at: number; source_query: string; related_notes: string[] } }
/** Calendar event created by the agent. */
export interface AgentActionResultCalendarCreated { kind: "calendar_event_created"; event: CalendarEvent }
/** Calendar event updated by the agent. */
export interface AgentActionResultCalendarUpdated { kind: "calendar_event_updated"; event: CalendarEvent }
/** Calendar event deleted by the agent. */
export interface AgentActionResultCalendarDeleted { kind: "calendar_event_deleted"; id: string }
/** Calendar events listed for the agent. */
export interface AgentActionResultCalendarListed { kind: "calendar_events_listed"; events: CalendarEvent[] }
/** `.ics` imported by the agent. */
export interface AgentActionResultCalendarImported { kind: "calendar_ics_imported"; result: IcsImportResult }

/** Tagged result of the `cmd_agent_*` router commands. */
export type AgentActionResult =
  | AgentActionResultOpened
  | AgentActionResultClipped
  | AgentActionResultFact
  | AgentActionResultAether
  | AgentActionResultCalendarCreated
  | AgentActionResultCalendarUpdated
  | AgentActionResultCalendarDeleted
  | AgentActionResultCalendarListed
  | AgentActionResultCalendarImported;
