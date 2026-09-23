import { describe, expect, it } from "vitest";
import {
  MESSAGE_OVERHEAD_TOKENS,
  estimateConversationTokens,
  estimateMessagesTokens,
  estimateTokens,
  formatTokens,
  meterLevel,
  needsCompaction,
} from "./tokens";

describe("token estimate", () => {
  it("is ceil(chars / 4), counting code points like the Rust side", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abc")).toBe(1);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("äöüß")).toBe(1);
    // An emoji is two UTF-16 units but one code point.
    expect(estimateTokens("😀😀😀😀")).toBe(1);
  });

  it("adds a per-message overhead and counts the summary once", () => {
    const messages = [{ content: "abcd" }, { content: "abcdefgh" }];
    expect(estimateMessagesTokens(messages)).toBe(1 + 2 + 2 * MESSAGE_OVERHEAD_TOKENS);
    expect(estimateConversationTokens("abcd", messages)).toBe(1 + MESSAGE_OVERHEAD_TOKENS + 3 + 2 * MESSAGE_OVERHEAD_TOKENS);
    expect(estimateConversationTokens("   ", [])).toBe(0);
    expect(estimateConversationTokens(null, [])).toBe(0);
  });
});

describe("threshold logic", () => {
  it("needs tokens above the threshold and something older than the kept window", () => {
    expect(needsCompaction(6_000, 6_000, 10, 4)).toBe(false);
    expect(needsCompaction(6_001, 6_000, 10, 4)).toBe(true);
    expect(needsCompaction(9_000, 6_000, 4, 4)).toBe(false);
    expect(needsCompaction(9_000, 6_000, 5, 4)).toBe(true);
    expect(needsCompaction(9_000, 6_000, 1, 0)).toBe(false);
  });

  it("colours the meter by tokens / threshold", () => {
    expect(meterLevel(0, 6_000)).toBe("ok");
    expect(meterLevel(4_499, 6_000)).toBe("ok");
    expect(meterLevel(4_500, 6_000)).toBe("warn");
    expect(meterLevel(6_000, 6_000)).toBe("warn");
    expect(meterLevel(6_001, 6_000)).toBe("over");
    expect(meterLevel(10, 0)).toBe("ok");
  });

  it("formats compact numbers", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(2_134)).toBe("2.1k");
    expect(formatTokens(6_000)).toBe("6k");
    expect(formatTokens(12_400)).toBe("12k");
    expect(formatTokens(-5)).toBe("0");
  });
});
