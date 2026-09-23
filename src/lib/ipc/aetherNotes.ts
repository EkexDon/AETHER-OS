/** AETHER Notes library commands (`src-tauri/src/commands/aether_note_commands.rs`). */
import type { AetherNote } from "../../types";
import { call } from "./core";

/** Save an AI answer to the AETHER Notes library (app data, not the vault). */
export const createAetherNote = (
  title: string,
  content: string,
  sourceQuery: string,
  relatedNotes: string[]
) => call<AetherNote>("cmd_create_aether_note", { title, content, sourceQuery, relatedNotes });
/** All AETHER Notes, newest first. */
export const getAetherNotes = () => call<AetherNote[]>("cmd_get_aether_notes");
/** Delete one AETHER Note by id. */
export const deleteAetherNote = (id: string) => call<void>("cmd_delete_aether_note", { id });
