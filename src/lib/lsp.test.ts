import { describe, expect, it } from "vitest";
import {
  combineDisposables,
  getConnection,
  offsetToPosition,
  pathToUri,
  positionToOffset,
  removeConnection,
  sessionKey,
  toMarkerSeverity,
  toMonacoRange,
  uriToPath,
} from "./lsp";

describe("lsp", () => {
  describe("sessionKey", () => {
    it("pairs language and root like the backend does", () => {
      expect(sessionKey("rust", "/tmp/a")).toBe("rust::/tmp/a");
      expect(sessionKey("rust", "/tmp/b")).not.toBe(sessionKey("rust", "/tmp/a"));
    });
  });

  describe("uri conversion", () => {
    it("encodes spaces and unicode into file URIs", () => {
      expect(pathToUri("/Users/x/my file.ts")).toBe("file:///Users/x/my%20file.ts");
      expect(pathToUri("/Users/x/日本.md")).toBe(
        "file:///Users/x/%E6%97%A5%E6%9C%AC.md"
      );
    });

    it("round-trips paths through URIs", () => {
      const samples = [
        "/simple/path.rs",
        "/with space/file name.ts",
        "/unicode/über/文件.py",
        "/trailing slash/dir/",
      ];
      for (const sample of samples) {
        expect(uriToPath(pathToUri(sample))).toBe(sample);
      }
    });
  });

  describe("position math", () => {
    const text = "line one\nline two\n\nlast";

    it("converts offsets to zero-based line/character", () => {
      expect(offsetToPosition(text, 0)).toEqual({ line: 0, character: 0 });
      // Offset 7 is the final 'e' of "one"; 8 is the newline itself.
      expect(offsetToPosition(text, 7)).toEqual({ line: 0, character: 7 });
      expect(offsetToPosition(text, 8)).toEqual({ line: 0, character: 8 });
      // Offset 9 is the first character of line two.
      expect(offsetToPosition(text, 9)).toEqual({ line: 1, character: 0 });
    });

    it("round-trips every position in the text", () => {
      for (let offset = 0; offset <= text.length; offset++) {
        const pos = offsetToPosition(text, offset);
        expect(positionToOffset(text, pos)).toBe(offset);
      }
    });

    it("clamps out-of-bounds input instead of throwing", () => {
      expect(offsetToPosition(text, -5)).toEqual({ line: 0, character: 0 });
      const beyond = offsetToPosition(text, text.length + 100);
      expect(beyond.line).toBe(3);
      expect(positionToOffset(text, { line: 99, character: 99 })).toBe(text.length);
    });

    it("handles empty text", () => {
      expect(offsetToPosition("", 0)).toEqual({ line: 0, character: 0 });
      expect(positionToOffset("", { line: 0, character: 0 })).toBe(0);
    });
  });

  describe("toMonacoRange", () => {
    it("shifts zero-based LSP ranges to one-based Monaco ranges", () => {
      expect(
        toMonacoRange({
          start: { line: 0, character: 2 },
          end: { line: 3, character: 7 },
        })
      ).toEqual({
        startLineNumber: 1,
        startColumn: 3,
        endLineNumber: 4,
        endColumn: 8,
      });
    });

    it("defaults to a 1×1 range at the origin when missing", () => {
      expect(toMonacoRange(undefined)).toEqual({
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: 1,
        endColumn: 1,
      });
    });
  });

  describe("severity mapping", () => {
    it("maps all four LSP severities onto Monaco markers", () => {
      expect(toMarkerSeverity(1)).toBe(8); // Error
      expect(toMarkerSeverity(2)).toBe(4); // Warning
      expect(toMarkerSeverity(3)).toBe(2); // Info
      expect(toMarkerSeverity(4)).toBe(1); // Hint
      expect(toMarkerSeverity(undefined)).toBe(8); // servers may omit it
    });
  });

  describe("connections registry", () => {
    it("returns the same connection per key and drops it on removal", () => {
      const a = getConnection("rust::/x");
      const b = getConnection("rust::/x");
      expect(b).toBe(a);
      removeConnection("rust::/x");
      expect(getConnection("rust::/x")).not.toBe(a);
      removeConnection("rust::/x");
    });
  });

  describe("combineDisposables", () => {
    it("runs functions and disposes objects exactly once when invoked", () => {
      let calls = 0;
      const fn = () => calls++;
      const disposable = { dispose: () => calls++ };
      const combined = combineDisposables(fn, disposable);
      expect(calls).toBe(0);
      combined();
      expect(calls).toBe(2);
    });
  });
});
