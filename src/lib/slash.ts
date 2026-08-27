/** Slash-command parsing for the chat input (e.g. "/model claude"). */

export type SlashCommand = {
  command: "model";
  query: string;
};

const SLASH_PATTERN = /^\/model(?:\s+(.*))?$/i;

export function parseSlashInput(input: string): SlashCommand | null {
  const match = SLASH_PATTERN.exec(input.trim());
  if (!match) return null;
  return { command: "model", query: (match[1] ?? "").trim() };
}

export function filterModels(models: string[], query: string, limit = 8): string[] {
  const q = query.toLowerCase();
  return models.filter((model) => model.toLowerCase().includes(q)).slice(0, limit);
}
