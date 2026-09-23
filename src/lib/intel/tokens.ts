/**
 * Token estimates for conversation compaction. Mirrors
 * `src-tauri/src/engine/intel/compaction.rs` exactly: `ceil(chars / 4)` per
 * text (Unicode code points, not UTF-16 units) plus 4 tokens of overhead
 * per message; the summary counts like one extra message.
 */

/** Characters per token of the heuristic. */
export const CHARS_PER_TOKEN = 4;
/** Fixed per-message cost (role markers, separators). */
export const MESSAGE_OVERHEAD_TOKENS = 4;
/** Default compaction threshold. */
export const DEFAULT_THRESHOLD_TOKENS = 6_000;
/** Default number of recent messages kept verbatim. */
export const DEFAULT_KEEP_RECENT = 4;

/** Anything with a `content` string (chat messages, records). */
export interface HasContent {
  content: string;
}

/** Estimated tokens of a text. */
export function estimateTokens(text: string): number {
  return Math.ceil(Array.from(text).length / CHARS_PER_TOKEN);
}

/** Estimated tokens of a list of messages, including overhead. */
export function estimateMessagesTokens(messages: readonly HasContent[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content) + MESSAGE_OVERHEAD_TOKENS, 0);
}

/** Estimated tokens the model sees: summary (if any) + verbatim messages. */
export function estimateConversationTokens(summary: string | null | undefined, messages: readonly HasContent[]): number {
  const s = summary?.trim() ?? "";
  const summaryTokens = s ? estimateTokens(s) + MESSAGE_OVERHEAD_TOKENS : 0;
  return summaryTokens + estimateMessagesTokens(messages);
}

/**
 * The threshold rule: compact once the estimate exceeds the threshold and
 * there is something older than the kept window to summarise.
 */
export function needsCompaction(tokens: number, threshold: number, messageCount: number, keepRecent: number): boolean {
  return tokens > threshold && messageCount > Math.max(1, keepRecent);
}

/** Colour band of the token meter chip. */
export type MeterLevel = "ok" | "warn" | "over";

/** `ok` below 75 % of the threshold, `warn` up to it, `over` beyond. */
export function meterLevel(tokens: number, threshold: number): MeterLevel {
  if (threshold <= 0) return "ok";
  const ratio = tokens / threshold;
  if (ratio > 1) return "over";
  if (ratio >= 0.75) return "warn";
  return "ok";
}

/** Compact number: `950`, `2.1k`, `12k`. */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(Math.max(0, Math.round(tokens)));
  const k = tokens / 1000;
  return k < 10 ? `${(Math.round(k * 10) / 10).toFixed(1).replace(/\.0$/, "")}k` : `${Math.round(k)}k`;
}
