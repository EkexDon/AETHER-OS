import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { applyFormat } from "./editorFormatting";

function createTestView(initialText: string, selection?: { anchor: number; head?: number }) {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const state = EditorState.create({
    doc: initialText,
    selection: selection ? { anchor: selection.anchor, head: selection.head ?? selection.anchor } : undefined,
  });
  return new EditorView({ state, parent });
}

describe("editorFormatting", () => {
  it("wraps selection with bold and unwraps if already bold", () => {
    const view = createTestView("hello world", { anchor: 6, head: 11 });
    applyFormat(view, "bold");
    expect(view.state.doc.toString()).toBe("hello **world**");

    // Re-select bolded text and apply format again to unwrap
    view.dispatch({ selection: { anchor: 6, head: 15 } });
    applyFormat(view, "bold");
    expect(view.state.doc.toString()).toBe("hello world");
    view.destroy();
  });

  it("applies italic formatting", () => {
    const view = createTestView("hello world", { anchor: 0, head: 5 });
    applyFormat(view, "italic");
    expect(view.state.doc.toString()).toBe("*hello* world");
    view.destroy();
  });

  it("applies strikethrough formatting", () => {
    const view = createTestView("test item", { anchor: 0, head: 4 });
    applyFormat(view, "strike");
    expect(view.state.doc.toString()).toBe("~~test~~ item");
    view.destroy();
  });

  it("applies inline code and multiline code blocks", () => {
    const view1 = createTestView("const x = 1", { anchor: 0, head: 11 });
    applyFormat(view1, "code");
    expect(view1.state.doc.toString()).toBe("`const x = 1`");
    view1.destroy();

    const view2 = createTestView("line1\nline2", { anchor: 0, head: 11 });
    applyFormat(view2, "code");
    expect(view2.state.doc.toString()).toBe("```\nline1\nline2\n```");
    view2.destroy();
  });

  it("applies heading prefixes to current line", () => {
    const view = createTestView("My Title", { anchor: 3 });
    applyFormat(view, "h1");
    expect(view.state.doc.toString()).toBe("# My Title");

    applyFormat(view, "h2");
    expect(view.state.doc.toString()).toBe("## My Title");

    applyFormat(view, "h3");
    expect(view.state.doc.toString()).toBe("### My Title");
    view.destroy();
  });

  it("applies list prefixes and task lists", () => {
    const view = createTestView("Todo item", { anchor: 2 });
    applyFormat(view, "taskList");
    expect(view.state.doc.toString()).toBe("- [ ] Todo item");

    applyFormat(view, "bulletList");
    expect(view.state.doc.toString()).toBe("- Todo item");

    applyFormat(view, "orderedList");
    expect(view.state.doc.toString()).toBe("1. Todo item");

    applyFormat(view, "quote");
    expect(view.state.doc.toString()).toBe("> Todo item");
    view.destroy();
  });

  it("inserts horizontal rule, link, and table", () => {
    const view = createTestView("some text", { anchor: 9 });
    applyFormat(view, "horizontalRule");
    expect(view.state.doc.toString()).toContain("---");

    const linkView = createTestView("click here", { anchor: 0, head: 10 });
    applyFormat(linkView, "link");
    expect(linkView.state.doc.toString()).toBe("[click here](https://)");
    linkView.destroy();

    const tableView = createTestView("text", { anchor: 4 });
    applyFormat(tableView, "table");
    expect(tableView.state.doc.toString()).toContain("| Column 1 | Column 2 | Column 3 |");
    tableView.destroy();
  });
});
