import { describe, expect, it, vi } from "vitest";
import type { PinItem } from "../../types";
import { isPinStale, normalizePinUrl, openPin, urlLabel, type PinOpenDeps } from "./pinActions";
import { applyFocusMode, createDoubleEscapeDetector } from "./focusMode";
import { greetingFor, noteTitleFromPath, relativeFolder, relativeTime, toLocalRfc3339 } from "./format";

function deps(overrides: Partial<PinOpenDeps> = {}): PinOpenDeps {
  return {
    notes: () => [{ path: "/v/a.md", name: "a", mtime: 1 }],
    selectNote: vi.fn(),
    setView: vi.fn(),
    setIdeRoot: vi.fn(),
    runCommand: vi.fn().mockResolvedValue(true),
    openConversation: vi.fn(async () => undefined),
    openUrl: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const pin = (kind: PinItem["kind"], ref: string): PinItem => ({ id: ref, kind, ref, label: ref });

describe("openPin", () => {
  it("opens notes in the editor", async () => {
    const d = deps();
    await openPin(pin("note", "/v/a.md"), d);
    expect(d.selectNote).toHaveBeenCalledWith("/v/a.md");
    expect(d.setView).toHaveBeenCalledWith("editor");
  });

  it("rejects notes that left the vault, but allows them before notes are loaded", async () => {
    await expect(openPin(pin("note", "/v/gone.md"), deps())).rejects.toThrow(/no longer in the vault/);
    const unloaded = deps({ notes: () => [] });
    await openPin(pin("note", "/v/gone.md"), unloaded);
    expect(unloaded.selectNote).toHaveBeenCalled();
  });

  it("opens projects as IDE roots", async () => {
    const d = deps();
    await openPin(pin("project", "/dev/app"), d);
    expect(d.setIdeRoot).toHaveBeenCalledWith("/dev/app");
    expect(d.setView).toHaveBeenCalledWith("ide");
  });

  it("runs commands and reports unavailable ones", async () => {
    const d = deps();
    await openPin(pin("command", "theme.toggle"), d);
    expect(d.runCommand).toHaveBeenCalledWith("theme.toggle");
    await expect(openPin(pin("command", "x"), deps({ runCommand: vi.fn().mockResolvedValue(false) }))).rejects.toThrow(/not available/);
  });

  it("opens the chat for conversations and the browser for URLs", async () => {
    const d = deps();
    await openPin(pin("conversation", "c1"), d);
    expect(d.openConversation).toHaveBeenCalledWith("c1");
    await openPin(pin("url", "example.com/docs"), d);
    expect(d.openUrl).toHaveBeenCalledWith("https://example.com/docs");
    await expect(openPin(pin("url", "javascript:alert(1)"), d)).rejects.toThrow(/not a valid web address/);
  });
});

describe("URLs", () => {
  it("normalises only http(s) addresses", () => {
    expect(normalizePinUrl("https://tauri.app")).toBe("https://tauri.app/");
    expect(normalizePinUrl("  docs.rs/serde  ")).toBe("https://docs.rs/serde");
    expect(normalizePinUrl("http://localhost:1420/x")).toBe("http://localhost:1420/x");
    expect(normalizePinUrl("file:///etc/passwd")).toBeNull();
    expect(normalizePinUrl("javascript:alert(1)")).toBeNull();
    expect(normalizePinUrl("not a url")).toBeNull();
    expect(normalizePinUrl("intranet")).toBeNull();
    expect(normalizePinUrl("")).toBeNull();
  });

  it("labels URLs compactly", () => {
    expect(urlLabel("https://www.example.com/")).toBe("example.com");
    expect(urlLabel("https://docs.rs/serde/latest/")).toBe("docs.rs/serde/latest");
    expect(urlLabel("nope")).toBe("nope");
  });
});

describe("isPinStale", () => {
  it("flags missing notes and unknown commands once data is loaded", () => {
    const notes = [{ path: "/v/a.md", name: "a", mtime: 1 }];
    expect(isPinStale(pin("note", "/v/b.md"), notes, new Set())).toBe(true);
    expect(isPinStale(pin("note", "/v/a.md"), notes, new Set())).toBe(false);
    expect(isPinStale(pin("note", "/v/b.md"), [], new Set())).toBe(false);
    expect(isPinStale(pin("command", "x"), notes, new Set(["y"]))).toBe(true);
    expect(isPinStale(pin("url", "https://a.b"), notes, new Set(["y"]))).toBe(false);
  });
});

describe("focus mode", () => {
  it("toggles the data-focus attribute", () => {
    const root = document.createElement("html");
    applyFocusMode(true, root);
    expect(root.getAttribute("data-focus")).toBe("true");
    applyFocusMode(false, root);
    expect(root.hasAttribute("data-focus")).toBe(false);
  });

  it("detects a double Escape within the window only", () => {
    const detect = createDoubleEscapeDetector(600);
    expect(detect(1000)).toBe(false);
    expect(detect(1500)).toBe(true);
    // Starts over after a hit.
    expect(detect(1600)).toBe(false);
    expect(detect(2500)).toBe(false);
    expect(detect(2900)).toBe(true);
  });
});

describe("format", () => {
  it("greets by time of day", () => {
    expect(greetingFor(new Date(2026, 8, 22, 3))).toBe("Good night");
    expect(greetingFor(new Date(2026, 8, 22, 8))).toBe("Good morning");
    expect(greetingFor(new Date(2026, 8, 22, 13))).toBe("Good afternoon");
    expect(greetingFor(new Date(2026, 8, 22, 21))).toBe("Good evening");
  });

  it("writes RFC 3339 with the local offset", () => {
    const ms = new Date(2026, 8, 22, 9, 5, 7).getTime();
    const s = toLocalRfc3339(ms);
    expect(s).toMatch(/^2026-09-22T09:05:07[+-]\d{2}:\d{2}$/);
    expect(Date.parse(s)).toBe(ms);
  });

  it("describes relative times", () => {
    const now = new Date(2026, 8, 22, 12).getTime();
    expect(relativeTime(now - 10_000, now)).toBe("just now");
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5m ago");
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(relativeTime(now - 30 * 3_600_000, now)).toBe("yesterday");
    expect(relativeTime(now - 4 * 86_400_000, now)).toBe("4d ago");
    expect(relativeTime(now - 15 * 86_400_000, now)).toBe("2w ago");
  });

  it("derives note titles and folders", () => {
    expect(noteTitleFromPath("/v/Projects/Plan.md")).toBe("Plan");
    expect(relativeFolder("/v/Projects/Sub/Plan.md", "/v")).toBe("Projects/Sub");
    expect(relativeFolder("/v/Plan.md", "/v/")).toBe("");
  });
});
