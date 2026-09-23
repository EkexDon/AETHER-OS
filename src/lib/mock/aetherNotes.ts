/** Mock handlers for `commands/aether_note_commands.rs`, plus the shared
 *  AETHER Notes store used by the agent-action router mock. */
import type { AetherNote } from "../../types";
import {
  argString,
  argStringArray,
  mockUuid,
  registerReset,
  type MockHandlerMap,
} from "./runtime";

function seed(): AetherNote[] {
  const day = 86_400_000;
  return [
    {
      id: mockUuid(),
      title: "Summary: Masterarbeit status",
      content:
        "## Stand der Masterarbeit\n\n- Exposé ist abgegeben.\n- Kapitel 2 braucht eine Überarbeitung.\n- Nächster Schritt: Evaluationsdatensatz mit 50 Fragen.\n\nQuellen: [[Masterarbeit]], [[Masterarbeit Literatur]]",
      source_query: "Wie ist der Stand meiner Masterarbeit?",
      related_notes: [],
      created_at: new Date(Date.now() - 2 * day).toISOString(),
    },
    {
      id: mockUuid(),
      title: "Ollama model comparison",
      content:
        "| Model | Size | Good for |\n| --- | --- | --- |\n| qwen2.5:7b | 4.7 GB | chat, tool calls |\n| llama3.2:1b | 1.3 GB | quick summaries |\n| gemma2:2b | 1.6 GB | classification |",
      source_query: "Which local model should I use?",
      related_notes: [],
      created_at: new Date(Date.now() - 5 * day).toISOString(),
    },
  ];
}

let notes = seed();
registerReset(() => {
  notes = seed();
});

/** Create an AETHER Note (title required), like `AetherNotes::create`. */
export function createAetherNoteRecord(
  title: string,
  content: string,
  sourceQuery: string,
  relatedNotes: string[]
): AetherNote {
  if (!title.trim()) throw new Error("invalid input: title is required");
  const note: AetherNote = {
    id: mockUuid(),
    title,
    content,
    source_query: sourceQuery,
    related_notes: relatedNotes,
    created_at: new Date().toISOString(),
  };
  notes.push(note);
  return note;
}

export const aetherNotesHandlers: MockHandlerMap = {
  cmd_create_aether_note: (args) =>
    createAetherNoteRecord(
      argString(args, "title"),
      argString(args, "content"),
      argString(args, "sourceQuery"),
      argStringArray(args, "relatedNotes")
    ),
  cmd_get_aether_notes: () => [...notes].sort((a, b) => b.created_at.localeCompare(a.created_at)),
  cmd_delete_aether_note: (args) => {
    const id = argString(args, "id");
    const before = notes.length;
    notes = notes.filter((n) => n.id !== id);
    if (notes.length === before) {
      throw new Error(`I/O error: No such file or directory (os error 2)`);
    }
  },
};
