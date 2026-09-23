import { describe, expect, it } from "vitest";
import { CallRateLimiter, MAX_PAYLOAD_SIZE, formatLimit, payloadSize } from "./limits";

describe("payloadSize", () => {
  it("approximates the serialised size of plain data", () => {
    expect(payloadSize("abc")).toBe(5);
    expect(payloadSize(null)).toBe(8);
    expect(payloadSize([1, "ab"])).toBe(2 + 2 + 8 + 4);
    expect(payloadSize({ k: "v" })).toBe(2 + 1 + (1 + 3) + 3);
  });

  it("stops walking once the limit is exceeded", () => {
    const big = Array.from({ length: 10_000 }, () => "x".repeat(1_000));
    const size = payloadSize(big, 50_000);
    expect(size).toBeGreaterThan(50_000);
    expect(size).toBeLessThan(60_000);
  });

  it("treats absurdly deep nesting as oversized", () => {
    let deep: unknown = "leaf";
    for (let i = 0; i < 100; i++) deep = [deep];
    expect(payloadSize(deep, MAX_PAYLOAD_SIZE)).toBeGreaterThan(MAX_PAYLOAD_SIZE);
  });

  it("formats limits for error messages", () => {
    expect(formatLimit(MAX_PAYLOAD_SIZE)).toBe("1 MB");
    expect(formatLimit(5 * 1024 * 1024 + 8 * 1024)).toBe("5 MB");
    expect(formatLimit(2048)).toBe("2 KB");
  });
});

describe("CallRateLimiter", () => {
  it("allows a burst, then refills over time", () => {
    let now = 0;
    const limiter = new CallRateLimiter(3, 10, () => now);
    expect([limiter.tryTake(), limiter.tryTake(), limiter.tryTake(), limiter.tryTake()]).toEqual([true, true, true, false]);
    expect(limiter.retryAfterMs()).toBe(100);
    now += 100;
    expect(limiter.tryTake()).toBe(true);
    expect(limiter.tryTake()).toBe(false);
    now += 10_000;
    // Never refills beyond the burst capacity.
    expect([limiter.tryTake(), limiter.tryTake(), limiter.tryTake(), limiter.tryTake()]).toEqual([true, true, true, false]);
  });

  it("ignores a clock that goes backwards", () => {
    let now = 1_000;
    const limiter = new CallRateLimiter(1, 1, () => now);
    expect(limiter.tryTake()).toBe(true);
    now = 0;
    expect(limiter.tryTake()).toBe(false);
  });
});
