/**
 * Round trips through the real editor: load a note body, serialize it
 * (with and without edits) and compare with the file's bytes.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";
import { noteEditorExtensions } from "./extensions";
import { splitFrontmatter } from "./frontmatter";
import { bodyToSave, canonicalMarkdown, editorMarkdown, loadBody } from "./noteBody";
import { lineToBlock, locateBlock, textKey } from "./lineToBlock";
import { buildVaultFixture } from "../mock/fixtures/vault";
import obsidianFixture from "./__fixtures__/obsidian-syntax.md?raw";
import tasksFixture from "../vaulttasks/__fixtures__/tasks.md?raw";

const NOW = new Date("2026-09-24T10:00:00");

const notes: { name: string; body: string }[] = [
  ...buildVaultFixture(NOW).map((n) => ({ name: n.rel, body: splitFrontmatter(n.content).body })),
  { name: "obsidian-syntax.md", body: splitFrontmatter(obsidianFixture).body },
  { name: "tasks.md", body: splitFrontmatter(tasksFixture).body },
];

/** Every Obsidian construct the serializer must write back verbatim. */
const OBSIDIAN = [
  /!?\[\[[^[\]\n]+\]\]/g, // wikilinks and embeds
  /(?:^|\s)#[\p{L}_/-][\p{L}\p{N}_/-]*/gmu, // tags
  /==[^=\n]+==/g, // highlights
  /%%[^%]+%%/g, // comments
  /\[\^[^\]]+\]/g, // footnotes
  /\[![a-z]+\][+-]?/g, // callouts
  /<!--[\s\S]*?-->/g, // HTML comments
  /\$\$[\s\S]+?\$\$|\$[^\s$][^$\n]*?[^\s$]\$(?!\d)/g, // math
];

function tokens(markdown: string): string[] {
  const withoutCode = markdown.replace(/```[\s\S]*?```|`[^`\n]*`/g, "");
  return OBSIDIAN.flatMap((re) => [...withoutCode.matchAll(re)].map((m) => m[0].trim())).sort();
}

/** Task lines outside code fences, trimmed (fence-aware like CommonMark: same char, at least as long). */
function taskLines(markdown: string): string[] {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of markdown.split("\n")) {
    const m = /^\s{0,3}(`{3,}(?=[^`]*$)|~{3,})/.exec(line);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && !line.slice(m[0].length).trim()) fence = null;
      continue;
    }
    if (m) {
      fence = m[1];
      continue;
    }
    if (/^[\s>]*(?:[-*+]|\d+[.)]) \[[ xX/-]\] \S/.test(line)) out.push(line.trim().replace(/\s+$/, ""));
  }
  return out;
}

let editor: Editor;

beforeAll(() => {
  editor = new Editor({ extensions: noteEditorExtensions(), content: "" });
});

afterAll(() => editor.destroy());

describe("load → save without edits", () => {
  it.each(notes.map((n) => [n.name, n.body]))("%s is byte-identical", (_name, body) => {
    const base = loadBody(editor, body);
    expect(bodyToSave(editor, base)).toBe(body);
  });

  it("keeps CRLF files byte-identical", () => {
    const body = notes[0].body.replace(/\n/g, "\r\n");
    const base = loadBody(editor, body);
    expect(bodyToSave(editor, base)).toBe(body);
  });
});

describe("the serializer itself", () => {
  it.each(notes.map((n) => [n.name, n.body]))("%s: writes every Obsidian construct back verbatim", (_name, body) => {
    loadBody(editor, body);
    const canonical = editorMarkdown(editor);
    expect(tokens(canonical)).toEqual(tokens(body));
    expect(canonical).not.toMatch(/\\\[\\\[|\\\]\\\]/);
  });

  it.each(notes.map((n) => [n.name, n.body]))("%s: is stable (reading its own output changes nothing)", (_name, body) => {
    loadBody(editor, body);
    const canonical = editorMarkdown(editor);
    expect(canonicalMarkdown(editor, canonical)).toBe(canonical);
  });

  it.each(notes.map((n) => [n.name, n.body]))("%s: keeps every task and adds none", (_name, body) => {
    loadBody(editor, body);
    const canonical = editorMarkdown(editor);
    expect(taskLines(canonical)).toEqual(taskLines(body).map((l) => l.replace("[X]", "[x]")));
    // No invented empty tasks (ProseMirror used to add one to mixed lists).
    const empty = (md: string) => md.match(/^\s*[-*+] \[ \]\s*$/gm)?.length ?? 0;
    expect(empty(canonical)).toBe(empty(body));
  });

  it("writes the P0 regression note without escapes", () => {
    const aether = buildVaultFixture(NOW).find((n) => n.rel === "01-Projects/AETHER-OS.md")!;
    loadBody(editor, splitFrontmatter(aether.content).body);
    const md = editorMarkdown(editor);
    expect(md).toContain("- Knowledge: vault reader, [[Vector Search Basics]] and graph view.");
    expect(md).toContain("![[aether-architecture.png|480]]");
    expect(md).toContain("Roadmap: [[AETHER-OS Roadmap]]");
    expect(md).not.toContain("\\[");
  });
});

// ── Small edits change only their own lines ──────────────────────

function changedLines(before: string, after: string): { removed: string[]; added: string[] } {
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  return { removed: a.slice(start, endA), added: b.slice(start, endB) };
}

interface LineTarget {
  line: number;
  node: PmNode;
  pos: number;
}

/** Source lines that are the whole, single-line text of one editor text block. */
function editableLines(body: string): LineTarget[] {
  const lines = body.split("\n");
  const out: LineTarget[] = [];
  let fenced = false;
  lines.forEach((text, line) => {
    if (/^\s*(```|~~~)/.test(text)) fenced = !fenced;
    // Skip fences, tables, raw blocks and headings with a closing `##` (text goes before it).
    if (fenced || !text.trim() || /^\s*(\||```|~~~|\$\$|%%|<!--)/.test(text) || /^#{1,6} .*\s#+\s*$/.test(text)) return;
    const target = lineToBlock(body, line);
    if (!target) return;
    const located = locateBlock(editor.state.doc, target);
    if (!located) return;
    const node = located.node.isTextblock ? located.node : located.node.firstChild;
    if (!node?.isTextblock || node.childCount === 0) return;
    // Only blocks shown on this one source line (no soft breaks, same text).
    if (node.textContent.includes("\n") || textKey(node.textContent) !== target.text && textKey(node.textContent) !== textKey(target.text)) return;
    let hasBreak = false;
    node.forEach((child) => {
      if (child.type.name === "hardBreak") hasBreak = true;
    });
    if (hasBreak) return;
    const pos = located.node.isTextblock ? located.pos : located.pos + 1;
    out.push({ line, node, pos });
  });
  return out;
}

describe("load → small edit → save", () => {
  it.each(notes.map((n) => [n.name, n.body]))("%s: appending to one line changes only that line", (_name, body) => {
    const targets = (() => {
      loadBody(editor, body);
      return editableLines(body).map((t) => t.line);
    })();
    expect(targets.length).toBeGreaterThan(0);
    for (const line of targets) {
      const base = loadBody(editor, body);
      const target = editableLines(body).find((t) => t.line === line)!;
      // End of the text block's content.
      editor.commands.insertContentAt(target.pos + target.node.nodeSize - 1, " edited");
      const saved = bodyToSave(editor, base);
      const diff = changedLines(body, saved);
      const original = body.split("\n")[line];
      expect(diff, `line ${line}: ${original}`).toEqual({ removed: [original], added: [`${original.trimEnd()} edited`] });
    }
  });

  it.each(notes.map((n) => [n.name, n.body]))("%s: ticking a task changes only its checkbox", (_name, body) => {
    loadBody(editor, body);
    const count = (() => {
      let n = 0;
      editor.state.doc.descendants((node) => {
        if (node.type.name === "taskItem") n++;
      });
      return n;
    })();
    for (let index = 0; index < count; index++) {
      const base = loadBody(editor, body);
      let pos = -1;
      let seen = 0;
      editor.state.doc.descendants((node, p) => {
        if (node.type.name === "taskItem" && seen++ === index) pos = p;
        return pos === -1;
      });
      const item = editor.state.doc.nodeAt(pos)!;
      editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...item.attrs, checked: !item.attrs.checked }));
      const diff = changedLines(body, bodyToSave(editor, base));
      expect(diff.removed.length, `task ${index}`).toBe(1);
      expect(diff.added.length, `task ${index}`).toBe(1);
      const flip = (line: string) => line.replace(/\[( |x|X)\]/, (_m, c: string) => (c === " " ? "[x]" : "[ ]"));
      expect(diff.added[0]).toBe(flip(diff.removed[0]));
    }
  });

  it("keeps wikilinks, the blank line before a task and the rest of the note when a line is edited", () => {
    const note = buildVaultFixture(NOW).find((n) => n.rel === "01-Projects/Local-first Sync.md")!;
    const body = splitFrontmatter(note.content).body;
    const base = loadBody(editor, body);
    // Edit the paragraph that ends with [[AETHER-OS]] (the one the bug report shows).
    let pos = -1;
    editor.state.doc.descendants((node, p) => {
      if (pos === -1 && node.type.name === "paragraph" && node.textContent.startsWith("Leaning towards")) pos = p;
    });
    const paragraph = editor.state.doc.nodeAt(pos)!;
    editor.commands.insertContentAt(pos + paragraph.nodeSize - 1, " Decided.");
    const saved = bodyToSave(editor, base);
    expect(saved).toBe(body.replace("already ships git support.", "already ships git support. Decided."));
    expect(saved).toContain("[[AETHER-OS]]");
    expect(saved).toContain("Your data stays usable offline and never depends on a server.\n\n- [ ] Compare");
  });

  it("appends a paragraph at the end without touching the note", () => {
    for (const { body } of notes.slice(0, 6)) {
      const base = loadBody(editor, body);
      editor.commands.insertContentAt(editor.state.doc.content.size, { type: "paragraph", content: [{ type: "text", text: "Appended" }] });
      const saved = bodyToSave(editor, base);
      expect(saved.startsWith(body.replace(/\n+$/, ""))).toBe(true);
      expect(saved.endsWith("Appended\n")).toBe(true);
    }
  });

  it("deletes one list item without touching its neighbours", () => {
    const body = "# Tasks\n- [ ] one [[A]]\n- [ ] two\n- [ ] three\n\nAfter.\n";
    const base = loadBody(editor, body);
    let from = -1;
    let to = -1;
    editor.state.doc.descendants((node, p) => {
      if (from === -1 && node.type.name === "taskItem" && node.textContent === "two") {
        from = p;
        to = p + node.nodeSize;
      }
    });
    editor.view.dispatch(editor.state.tr.delete(from, to));
    expect(bodyToSave(editor, base)).toBe("# Tasks\n- [ ] one [[A]]\n- [ ] three\n\nAfter.\n");
  });

  it("adds a first task right under a heading without a blank line", () => {
    const body = "## Tasks\n- [ ] existing\n";
    const base = loadBody(editor, body);
    editor.commands.insertContentAt(editor.state.doc.child(0).nodeSize + 1, {
      type: "taskItem",
      attrs: { checked: false },
      content: [{ type: "paragraph", content: [{ type: "text", text: "new" }] }],
    });
    expect(bodyToSave(editor, base)).toBe("## Tasks\n- [ ] new\n- [ ] existing\n");
  });

  it("falls back to the edited serialization when a merge would read differently", () => {
    // Turning the list item into a paragraph: next to "Intro:" (no blank line in
    // the file) the plain merge would glue both into one paragraph.
    const body = "Intro:\n- a\n- b\n";
    const base = loadBody(editor, body);
    let inside = -1;
    editor.state.doc.descendants((node, pos) => {
      if (inside === -1 && node.isText && node.text === "a") inside = pos + 1;
    });
    expect(editor.chain().setTextSelection(inside).liftListItem("listItem").run()).toBe(true);
    const saved = bodyToSave(editor, base);
    expect(saved).toBe("Intro:\n\na\n\n- b\n");
    expect(canonicalMarkdown(editor, saved)).toBe(canonicalMarkdown(editor, editorMarkdown(editor)));
  });
});
