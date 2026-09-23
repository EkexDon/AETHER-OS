import { describe, expect, it } from "vitest";
import { splitTruncation } from "./commandOutput";

describe("splitTruncation", () => {
  it("splits the Rust marker off a truncated stream", () => {
    expect(splitTruncation("line 1\nline 2\n[… output truncated at 64 KiB]")).toEqual({
      text: "line 1\nline 2",
      marker: "output truncated at 64 KiB",
    });
  });

  it("leaves complete output alone", () => {
    expect(splitTruncation("ok\n")).toEqual({ text: "ok\n", marker: null });
    expect(splitTruncation("")).toEqual({ text: "", marker: null });
    // A command printing something similar in the middle is not a marker.
    expect(splitTruncation("[… output truncated at 1 KiB] is what it said\n").marker).toBeNull();
  });
});
