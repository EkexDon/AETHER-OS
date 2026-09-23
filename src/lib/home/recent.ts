/** "Continue where you left off" selections for the Home dashboard. */
import type { Conversation, Project, VaultNote } from "../../types";

/** Most recently modified notes first. */
export function recentNotes(notes: VaultNote[], limit: number): VaultNote[] {
  return [...notes].sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name)).slice(0, Math.max(0, limit));
}

/** Projects with the most recent commit first (never-committed last). */
export function recentProjects(projects: Project[], limit: number): Project[] {
  return [...projects]
    .sort((a, b) => (b.last_commit_date ?? 0) - (a.last_commit_date ?? 0) || a.name.localeCompare(b.name))
    .slice(0, Math.max(0, limit));
}

/** Newest conversations first. */
export function recentConversations(conversations: Conversation[], limit: number): Conversation[] {
  return [...conversations].sort((a, b) => b.timestamp - a.timestamp).slice(0, Math.max(0, limit));
}

/** Tone of a project's git status chip. */
export function gitStatusTone(status: string | null): "success" | "warning" | "neutral" {
  if (!status) return "neutral";
  return status === "clean" ? "success" : "warning";
}

/** Short git status text: `clean`, `3 changed`, `no git`. */
export function gitStatusLabel(status: string | null): string {
  if (!status) return "no git";
  if (status === "clean") return "clean";
  const total = [...status.matchAll(/(\d+)\s+(?:modified|untracked)/g)].reduce((n, m) => n + Number(m[1]), 0);
  return total > 0 ? `${total} changed` : status;
}

/** A readable title: the summary, else the first user message, else "Conversation". */
export function conversationTitle(conversation: Conversation, max = 80): string {
  const source =
    conversation.summary.trim() ||
    conversation.messages.find((m) => m.role === "user")?.content.trim() ||
    conversation.messages[0]?.content.trim() ||
    "";
  const oneLine = source.replace(/\s+/g, " ");
  if (!oneLine) return "Conversation";
  return oneLine.length > max ? `${oneLine.slice(0, max - 1).trimEnd()}…` : oneLine;
}
