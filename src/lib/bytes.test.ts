import { describe, expect, it } from "vitest";
import { base64ToBytes, bytesToBase64 } from "./bytes";

describe("bytes", () => {
  it("decodes ASCII payloads exactly", () => {
    expect(new TextDecoder().decode(base64ToBytes(btoa("git status")))).toBe("git status");
  });

  it("preserves binary bytes that a UTF-8 round-trip would corrupt", () => {
    const original = Uint8Array.from([0xff, 0xfe, 0xf0, 0x9f, 0x91, 0x80, 0x1b, 0x5b, 0x4b]);
    expect(Array.from(base64ToBytes(bytesToBase64(original)))).toEqual(Array.from(original));
  });

  it("round-trips empty payloads", () => {
    expect(base64ToBytes(bytesToBase64(new Uint8Array())).length).toBe(0);
  });
});
