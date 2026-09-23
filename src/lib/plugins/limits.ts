/**
 * Resource limits the plugin host enforces on every call from a worker,
 * before the call is validated or reaches IPC:
 *
 * - **Payload size** — {@link payloadSize} measures the parameters of a
 *   request without serialising them and stops as soon as the budget is
 *   exceeded, so an oversized payload costs at most one partial walk.
 * - **Call rate** — {@link CallRateLimiter} is a token bucket per plugin
 *   (a burst of {@link MAX_CALL_BURST} calls, refilled at
 *   {@link MAX_CALLS_PER_SECOND} per second).
 */

/** Default cap on the parameters of one plugin API call (1 MiB of characters). */
export const MAX_PAYLOAD_SIZE = 1024 * 1024;
/** Calls a plugin may make back to back before the rate limit applies. */
export const MAX_CALL_BURST = 200;
/** Sustained API calls per second per plugin. */
export const MAX_CALLS_PER_SECOND = 100;

const PRIMITIVE_SIZE = 8;

/**
 * Approximate serialised size of plain data in characters (≈ bytes for
 * ASCII): strings count their length plus quotes, numbers/booleans/null a
 * fixed 8, containers their entries plus keys. Returns a value greater
 * than `limit` as soon as the running total exceeds it (the exact number
 * is then meaningless). Cycles are counted once per visit, which the
 * running total and the depth cap turn into an early exit.
 */
export function payloadSize(value: unknown, limit = Number.POSITIVE_INFINITY): number {
  let total = 0;
  const stack: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  while (stack.length > 0) {
    const { value: current, depth } = stack.pop()!;
    if (typeof current === "string") total += current.length + 2;
    else if (current === null || current === undefined || typeof current !== "object") total += PRIMITIVE_SIZE;
    else if (depth > 64) return limit + 1;
    else if (Array.isArray(current)) {
      total += 2 + current.length;
      for (const item of current) stack.push({ value: item, depth: depth + 1 });
    } else {
      const entries = Object.entries(current as Record<string, unknown>);
      total += 2 + entries.length;
      for (const [key, item] of entries) {
        total += key.length + 3;
        stack.push({ value: item, depth: depth + 1 });
      }
    }
    if (total > limit) return total;
  }
  return total;
}

/** `1048576` → `1 MB`, `5242880` → `5 MB`, `2048` → `2 KB`. */
export function formatLimit(size: number): string {
  if (size >= 1024 * 1024) return `${Math.round((size / 1024 / 1024) * 10) / 10} MB`;
  if (size >= 1024) return `${Math.round(size / 1024)} KB`;
  return `${size} characters`;
}

/**
 * Token bucket: {@link tryTake} succeeds while tokens are left; tokens
 * refill continuously at `refillPerSecond` up to `capacity`.
 */
export class CallRateLimiter {
  private tokens: number;
  private last: number;

  constructor(
    readonly capacity = MAX_CALL_BURST,
    readonly refillPerSecond = MAX_CALLS_PER_SECOND,
    private readonly now: () => number = () => Date.now()
  ) {
    this.tokens = capacity;
    this.last = now();
  }

  private refill(): void {
    const at = this.now();
    const elapsed = Math.max(0, at - this.last);
    this.last = at;
    this.tokens = Math.min(this.capacity, this.tokens + (elapsed / 1000) * this.refillPerSecond);
  }

  /** Take one token; `false` when the bucket is empty (the call must be refused). */
  tryTake(): boolean {
    this.refill();
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  /** Milliseconds until the next call would be allowed (0 when one is available now). */
  retryAfterMs(): number {
    this.refill();
    return this.tokens >= 1 ? 0 : Math.ceil(((1 - this.tokens) / this.refillPerSecond) * 1000);
  }
}
