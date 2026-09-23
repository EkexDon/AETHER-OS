/**
 * Command output of `run_command` as the approval/"Tools used" UI shows it.
 * Rust caps each stream at 64 KiB and appends `TRUNCATION_MARKER`
 * (`shell_exec.rs`): "\n[… output truncated at 64 KiB]". The UI splits
 * that marker off so it can be rendered as a distinct notice instead of
 * looking like the command's own last line.
 */

/** The marker line Rust appends to a truncated stream (without the leading newline). */
export const TRUNCATION_MARKER_RE = /\n?\[… output truncated at [^\]\n]+\]\s*$/;

/** A stream split into its text and the truncation marker, if any. */
export interface SplitStream {
  text: string;
  /** e.g. "output truncated at 64 KiB"; `null` when the stream was complete. */
  marker: string | null;
}

/** Split Rust's truncation marker off the end of `stream`. */
export function splitTruncation(stream: string): SplitStream {
  const match = TRUNCATION_MARKER_RE.exec(stream);
  if (!match) return { text: stream, marker: null };
  const marker = match[0].trim().replace(/^\[…\s*/, "").replace(/\]$/, "");
  return { text: stream.slice(0, match.index), marker };
}
