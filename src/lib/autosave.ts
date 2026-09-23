/**
 * Debounced autosave that remembers *which* note a pending save belongs to.
 *
 * The editor used to look the target note up when the timer fired. Switching
 * notes inside the debounce window then wrote note A's text into note B. The
 * scheduler binds path and content together at scheduling time, and callers
 * flush the pending save before the selection changes so nothing is lost.
 */

export interface PendingSave {
  path: string;
  content: string;
}

export interface AutosaveScheduler {
  /** Debounce a save of `content` for `path`, replacing any pending save. */
  schedule(path: string, content: string): void;
  /** Save immediately whatever is pending (if anything). */
  flush(): Promise<void>;
  /**
   * Save the pending change immediately if it belongs to a note other than
   * `currentPath`. Called when the selection changes so the old note's last
   * keystrokes still land in the old note.
   */
  flushIfNot(currentPath: string | null): Promise<void>;
  /** Drop the pending save without writing it. */
  cancel(): void;
  /** The pending save, or null. */
  pending(): PendingSave | null;
}

export interface AutosaveOptions {
  delayMs: number;
  save: (path: string, content: string) => Promise<void>;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

/** Create a scheduler; the editor owns one instance for its lifetime. */
export function createAutosaveScheduler(options: AutosaveOptions): AutosaveScheduler {
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  let pending: PendingSave | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clear = () => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  };

  const fire = async () => {
    const job = pending;
    pending = null;
    clear();
    if (!job) return;
    await options.save(job.path, job.content);
  };

  return {
    schedule(path, content) {
      clear();
      pending = { path, content };
      timer = setTimer(() => {
        void fire();
      }, options.delayMs);
    },
    flush: () => fire(),
    async flushIfNot(currentPath) {
      if (pending && pending.path !== currentPath) await fire();
    },
    cancel() {
      clear();
      pending = null;
    },
    pending: () => pending,
  };
}
