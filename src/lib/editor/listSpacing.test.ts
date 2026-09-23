import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { noteEditorExtensions } from "./extensions";
import { prefersTightLists, tightenListSpacing } from "./listSpacing";

/** Round-trip through the real editor serializer. */
function roundTrip(markdown: string): string {
  const editor = new Editor({ extensions: noteEditorExtensions(), content: "" });
  editor.commands.setContent(markdown, { emitUpdate: false });
  const storage = editor.storage as unknown as { markdown: { getMarkdown: () => string } };
  const out = storage.markdown.getMarkdown();
  editor.destroy();
  return out;
}

describe("prefersTightLists", () => {
  it("detects Obsidian-style lists directly under headings and paragraphs", () => {
    expect(prefersTightLists("## Tasks\n- [ ] a\n- [ ] b\n")).toBe(true);
    expect(prefersTightLists("Intro:\n- a\n\n## More\n\n- b\n")).toBe(true);
    expect(prefersTightLists("## Tasks\n\n- a\n\nText\n\n1. b\n")).toBe(false);
    expect(prefersTightLists("No lists here.\n")).toBe(false);
    expect(prefersTightLists("```\ncode\n- not a list\n```\n")).toBe(false);
  });
});

describe("tightenListSpacing", () => {
  it("removes only the blank line between a block and the list below it", () => {
    expect(tightenListSpacing("## Tasks\n\n- [ ] a\n- [ ] b\n\nAfter\n")).toBe("## Tasks\n- [ ] a\n- [ ] b\n\nAfter\n");
    expect(tightenListSpacing("Intro\n\n1. one\n2. two")).toBe("Intro\n1. one\n2. two");
  });

  it("keeps blank lines CommonMark needs", () => {
    const keep = [
      "Text\n\n3. not a list after a paragraph",
      "> quote\n\n- item",
      "| a |\n| - |\n\n- item",
      "---\n\n- item",
      "```\ncode\n\n- literal\n```",
      "- a\n\n- loose list stays loose",
      "Text\n\n    - indented code",
    ];
    for (const md of keep) expect(tightenListSpacing(md), md).toBe(md);
    expect(tightenListSpacing("## Steps\n\n3. third")).toBe("## Steps\n3. third");
  });

  it("round-trips a tight note through the editor unchanged", () => {
    const note = "# AETHER-OS\n\nA paragraph.\n\n## Tasks\n- [ ] Write release notes #aether\n- [x] Split the IPC layer\n\n## Pillars\n- Knowledge\n- Build\n";
    const serialized = roundTrip(note);
    expect(serialized).not.toBe(note.trimEnd()); // the raw serializer adds blank lines…
    expect(tightenListSpacing(serialized)).toBe(note.trimEnd()); // …which are removed again
  });
});
