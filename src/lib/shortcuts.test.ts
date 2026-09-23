import { describe, expect, it } from "vitest";
import { formatShortcut, isEditableTarget, matchesShortcut, parseShortcut, shortcutKeys, type KeyLike } from "./shortcuts";

function key(k: string, mods: Partial<KeyLike> = {}): KeyLike {
  return { key: k, code: mods.code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods };
}

describe("parseShortcut", () => {
  it("splits modifiers and key", () => {
    expect(parseShortcut("mod+shift+N")).toEqual({
      mod: true,
      ctrl: false,
      alt: false,
      shift: true,
      meta: false,
      key: "n",
    });
    expect(parseShortcut("esc").key).toBe("escape");
    expect(parseShortcut("mod++").key).toBe("+");
  });

  it("rejects shortcuts without a key", () => {
    expect(() => parseShortcut("mod+shift")).toThrow(/no key/);
  });
});

describe("matchesShortcut", () => {
  it("maps mod to ⌘ on macOS and Ctrl elsewhere", () => {
    expect(matchesShortcut(key("k", { metaKey: true }), "mod+k", true)).toBe(true);
    expect(matchesShortcut(key("k", { ctrlKey: true }), "mod+k", true)).toBe(false);
    expect(matchesShortcut(key("k", { ctrlKey: true }), "mod+k", false)).toBe(true);
    expect(matchesShortcut(key("k", { metaKey: true }), "mod+k", false)).toBe(false);
  });

  it("requires the exact modifier set", () => {
    expect(matchesShortcut(key("n", { metaKey: true, shiftKey: true }), "mod+n", true)).toBe(false);
    expect(matchesShortcut(key("N", { metaKey: true, shiftKey: true }), "mod+shift+n", true)).toBe(true);
    expect(matchesShortcut(key("k", { metaKey: true, altKey: true }), "mod+k", true)).toBe(false);
  });

  it("ignores Shift for punctuation that needs it on some layouts", () => {
    // German layout: "/" is Shift+7.
    expect(matchesShortcut(key("/", { metaKey: true, shiftKey: true }), "mod+/", true)).toBe(true);
  });

  it("falls back to the physical key code", () => {
    // ⌥ changes the produced character on macOS.
    expect(matchesShortcut(key("˜", { metaKey: true, altKey: true, code: "KeyN" }), "mod+alt+n", true)).toBe(true);
    expect(matchesShortcut(key("!", { metaKey: true, code: "Digit1" }), "mod+1", true)).toBe(true);
  });
});

describe("formatting", () => {
  it("renders macOS symbols in canonical order", () => {
    expect(shortcutKeys("mod+shift+n", true)).toEqual(["⇧", "⌘", "N"]);
    expect(formatShortcut("mod+k", true)).toBe("⌘K");
    expect(formatShortcut("mod+,", true)).toBe("⌘,");
  });

  it("renders words elsewhere", () => {
    expect(formatShortcut("mod+shift+n", false)).toBe("Ctrl+Shift+N");
    expect(formatShortcut("escape", false)).toBe("Esc");
    expect(shortcutKeys("shift+enter", false)).toEqual(["Shift", "↵"]);
  });
});

describe("isEditableTarget", () => {
  it("detects inputs, textareas and contenteditable", () => {
    const input = document.createElement("input");
    const div = document.createElement("div");
    const editable = document.createElement("div");
    editable.contentEditable = "true";
    document.body.append(editable);
    expect(isEditableTarget(input)).toBe(true);
    expect(isEditableTarget(div)).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
    editable.remove();
  });
});
