import { describe, expect, it } from "vitest";
import { classifyLink, findLinkedNote, findWikilinkNote } from "./links";

const ROOT = "/vault";
const notes = [
  { path: "/vault/Inbox.md", name: "Inbox", mtime: 0 },
  { path: "/vault/Projects/AETHER-OS.md", name: "AETHER-OS", mtime: 0 },
  { path: "/vault/Projects/AETHER-OS Roadmap.md", name: "AETHER-OS Roadmap", mtime: 0 },
  { path: "/vault/Archive/2025/Inbox.md", name: "Inbox", mtime: 0 },
];

describe("classifyLink", () => {
  it("sends web and mail links to the system browser", () => {
    expect(classifyLink("https://tauri.app")).toEqual({ kind: "external", url: "https://tauri.app/" });
    expect(classifyLink("mailto:ekin@example.com")).toEqual({ kind: "external", url: "mailto:ekin@example.com" });
  });

  it("drops dangerous and ambiguous targets", () => {
    for (const href of ["javascript:alert(1)", "java\tscript:alert(1)", "JAVASCRIPT:x", "data:text/html,x", "file:///etc", "vbscript:x", "tauri://x", "//evil.example", "\\\\evil", "C:\\x", "https://user:pw@example.com", "", undefined]) {
      expect(classifyLink(href).kind, String(href)).toBe("blocked");
    }
  });

  it("keeps anchors inert and treats relative paths as notes", () => {
    expect(classifyLink("#heading")).toEqual({ kind: "anchor" });
    expect(classifyLink("AETHER-OS%20Roadmap.md")).toEqual({ kind: "note", path: "AETHER-OS Roadmap.md" });
  });
});

describe("note resolution", () => {
  it("finds relative note links from the note's folder, then the vault root", () => {
    expect(findLinkedNote("AETHER-OS Roadmap.md", "/vault/Projects/AETHER-OS.md", ROOT, notes)?.path).toBe("/vault/Projects/AETHER-OS Roadmap.md");
    expect(findLinkedNote("Inbox", "/vault/Projects/AETHER-OS.md", ROOT, notes)?.path).toBe("/vault/Inbox.md");
    expect(findLinkedNote("../../etc/passwd", "/vault/Projects/AETHER-OS.md", ROOT, notes)).toBeNull();
    expect(findLinkedNote("Inbox", null, null, notes)).toBeNull();
  });

  it("resolves wikilinks by name (shortest path first) or by path", () => {
    expect(findWikilinkNote("inbox", ROOT, notes)?.path).toBe("/vault/Inbox.md");
    expect(findWikilinkNote("Archive/2025/Inbox", ROOT, notes)?.path).toBe("/vault/Archive/2025/Inbox.md");
    expect(findWikilinkNote("AETHER-OS", ROOT, notes)?.path).toBe("/vault/Projects/AETHER-OS.md");
    expect(findWikilinkNote("Nope", ROOT, notes)).toBeNull();
    expect(findWikilinkNote("  ", ROOT, notes)).toBeNull();
  });
});
