import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import fixture from "../vaulttasks/__fixtures__/tasks.md?raw";
import expected from "../vaulttasks/__fixtures__/tasks.expected.json";
import { frontmatterLineCount, splitFrontmatter } from "./frontmatter";
import { lineText, lineToBlock, locateBlock, textKey } from "./lineToBlock";
import { noteEditorExtensions } from "./extensions";

interface ExpectedTask {
  line: number;
  text_raw: string;
}

const { frontmatter, body } = splitFrontmatter(fixture);
const offset = frontmatterLineCount(frontmatter);
const bodyLines = body.split("\n");
const tasks = (expected as ExpectedTask[]).map((t) => ({ ...t, bodyLine: t.line - offset }));

describe("lineToBlock", () => {
  it("strips block markers from a line", () => {
    expect(lineText("- [ ] Plain todo")).toBe("Plain todo");
    expect(lineText("  2) [/] Numbered paren")).toBe("Numbered paren");
    expect(lineText(">   - [/] Quoted nested")).toBe("Quoted nested");
    expect(lineText("## Dates & priorities ##")).toBe("Dates & priorities ##");
    expect(textKey("Link to [[Other Note]] and [x](https://e.com)")).toBe("link to other note and x");
  });

  it("maps headings, paragraphs and blank lines to top-level blocks", () => {
    const md = "# Title\n\nFirst paragraph\nstill first\n\n- a\n- b\n\n```\ncode\n```\n";
    expect(lineToBlock(md, 0)).toEqual({ index: 0, itemPath: [], text: "Title" });
    expect(lineToBlock(md, 3)).toMatchObject({ index: 1, text: "still first" });
    // A blank line maps to the following block.
    expect(lineToBlock(md, 4)).toMatchObject({ index: 2, text: "" });
    expect(lineToBlock(md, 6)).toEqual({ index: 2, itemPath: [1], text: "b" });
    expect(lineToBlock(md, 9)).toMatchObject({ index: 3, text: "code" });
    expect(lineToBlock(md, 11)).toMatchObject({ index: 3 });
    expect(lineToBlock(md, 99)).toBeNull();
    expect(lineToBlock(md, -1)).toBeNull();
    expect(lineToBlock("", 0)).toBeNull();
  });

  it("follows nested list items", () => {
    const md = "- one\n  - two\n    - three\n  - four\n- five\n";
    expect(lineToBlock(md, 2)?.itemPath).toEqual([0, 0, 0]);
    expect(lineToBlock(md, 3)?.itemPath).toEqual([0, 1]);
    expect(lineToBlock(md, 4)?.itemPath).toEqual([1]);
  });

  it("finds a block for every task of the shared fixture", () => {
    expect(offset).toBe(5);
    for (const task of tasks) {
      const target = lineToBlock(body, task.bodyLine);
      expect(target, `line ${task.line}`).not.toBeNull();
      expect(bodyLines[task.bodyLine]).toContain(task.text_raw.trim().slice(0, 10));
      expect(target?.text.startsWith(task.text_raw.trim().slice(0, 10)), `line ${task.line}: ${target?.text}`).toBe(true);
    }
  });
});

describe("locateBlock in the editor document", () => {
  let editor: Editor;

  beforeAll(() => {
    editor = new Editor({ extensions: noteEditorExtensions(), content: "" });
    editor.commands.setContent(body, { emitUpdate: false });
  });

  afterAll(() => editor.destroy());

  it("resolves every fixture task to the block that shows its text", () => {
    for (const task of tasks) {
      const target = lineToBlock(body, task.bodyLine);
      if (!target) throw new Error(`no target for line ${task.line}`);
      const located = locateBlock(editor.state.doc, target);
      expect(located, `line ${task.line}`).not.toBeNull();
      const want = textKey(task.text_raw).slice(0, 14);
      expect(textKey(located!.node.textContent), `line ${task.line} → ${located!.node.type.name}`).toContain(want);
      // Outside block quotes the match is the list item itself.
      if (!bodyLines[task.bodyLine].startsWith(">")) {
        expect(["taskItem", "listItem"], `line ${task.line}`).toContain(located!.node.type.name);
        expect(editor.state.doc.nodeAt(located!.pos)).toBe(located!.node);
      }
    }
  });

  it("stays on the right task when many split lists shift the block indices", () => {
    const mixed = Array.from({ length: 12 }, (_, i) => `- [ ] Task ${i}\n- plain ${i}\n- [ ] Again ${i}\n`).join("\n");
    const md = `${mixed}\n<!-- hidden comment -->\n\n- [ ] Target task\n`;
    const local = new Editor({ extensions: noteEditorExtensions(), content: "" });
    try {
      local.commands.setContent(md, { emitUpdate: false });
      const lines = md.split("\n");
      for (const wanted of ["Again 11", "Task 7", "Target task"]) {
        const line = lines.findIndex((l) => l.includes(wanted));
        const located = locateBlock(local.state.doc, lineToBlock(md, line)!);
        expect(located?.node.textContent, wanted).toBe(wanted);
      }
    } finally {
      local.destroy();
    }
  });

  it("falls back to the structural block for lines without text", () => {
    const target = lineToBlock(body, 0);
    const located = locateBlock(editor.state.doc, target!);
    expect(located?.node.type.name).toBe("heading");
    expect(located?.pos).toBe(0);
  });
});
