import { describe, expect, it } from "vitest";
import { estimatePassphrase, passphraseWords, poolSize, MIN_PASSPHRASE_LENGTH } from "./entropy";

describe("estimatePassphrase", () => {
  it("rates an empty passphrase as very weak", () => {
    const e = estimatePassphrase("");
    expect(e.score).toBe(0);
    expect(e.bits).toBe(0);
    expect(e.acceptable).toBe(false);
  });

  it("caps common passwords, including leetspeak and suffix digits", () => {
    for (const p of ["password", "P@ssw0rd1", "qwerty123456", "letmein!!"]) {
      const e = estimatePassphrase(p);
      expect(e.score, p).toBe(0);
      expect(e.acceptable, p).toBe(false);
      expect(e.hints.join(" "), p).toMatch(/common|keyboard/);
    }
  });

  it("penalises repeats and sequences", () => {
    expect(estimatePassphrase("aaaaaaaaaaaa").score).toBe(0);
    expect(estimatePassphrase("abcdefgh").score).toBe(0);
    expect(estimatePassphrase("aaaaaaaaaaaa").hints.join(" ")).toMatch(/repeated/);
  });

  it("does not over-rate word passphrases", () => {
    const four = estimatePassphrase("correct horse battery staple");
    expect(four.bits).toBeGreaterThanOrEqual(48);
    expect(four.bits).toBeLessThan(64);
    expect(four.label).toBe("Strong");
    expect(four.acceptable).toBe(true);
    const five = estimatePassphrase("orbit maple lantern quiet falcon");
    expect(five.score).toBe(4);
  });

  it("rewards long random strings", () => {
    const e = estimatePassphrase("K7#mPq2$vL9x");
    expect(e.score).toBe(4);
    expect(e.bits).toBeGreaterThan(70);
  });

  it("requires the backend minimum length", () => {
    const e = estimatePassphrase("K7#mPq2");
    expect(e.acceptable).toBe(false);
    expect(e.hints[0]).toContain(`${MIN_PASSPHRASE_LENGTH} characters`);
  });

  it("is monotonic when appending a random word", () => {
    const a = estimatePassphrase("violet ocean");
    const b = estimatePassphrase("violet ocean sprocket");
    expect(b.bits).toBeGreaterThan(a.bits);
  });
});

describe("helpers", () => {
  it("computes the character pool", () => {
    expect(poolSize("abc")).toBe(26);
    expect(poolSize("aB1")).toBe(62);
    expect(poolSize("a!")).toBe(59);
    expect(poolSize("ä")).toBe(100);
  });

  it("splits passphrase words", () => {
    expect(passphraseWords("correct-horse_battery staple")).toEqual(["correct", "horse", "battery", "staple"]);
    expect(passphraseWords("a b c")).toEqual([]);
  });
});
