import { EditorView } from "@codemirror/view";

export type FormatType =
  | "bold"
  | "italic"
  | "strike"
  | "code"
  | "h1"
  | "h2"
  | "h3"
  | "quote"
  | "bulletList"
  | "orderedList"
  | "taskList"
  | "horizontalRule"
  | "link"
  | "table";

/**
 * Apply markdown formatting to the current selection or line in a CodeMirror EditorView.
 */
export function applyFormat(view: EditorView, type: FormatType) {
  const { state, dispatch } = view;
  const selection = state.selection.main;
  const from = selection.from;
  const to = selection.to;
  const selectedText = state.sliceDoc(from, to);

  switch (type) {
    case "bold": {
      if (selectedText.startsWith("**") && selectedText.endsWith("**") && selectedText.length >= 4) {
        // Unwrap bold
        dispatch({
          changes: { from, to, insert: selectedText.slice(2, -2) },
          selection: { anchor: from, head: to - 4 },
        });
      } else {
        const replacement = `**${selectedText || "bold text"}**`;
        dispatch({
          changes: { from, to, insert: replacement },
          selection: {
            anchor: from + (selectedText ? 0 : 2),
            head: from + replacement.length - (selectedText ? 0 : 2),
          },
        });
      }
      break;
    }

    case "italic": {
      if (selectedText.startsWith("*") && selectedText.endsWith("*") && selectedText.length >= 2) {
        // Unwrap italic
        dispatch({
          changes: { from, to, insert: selectedText.slice(1, -1) },
          selection: { anchor: from, head: to - 2 },
        });
      } else {
        const replacement = `*${selectedText || "italic text"}*`;
        dispatch({
          changes: { from, to, insert: replacement },
          selection: {
            anchor: from + (selectedText ? 0 : 1),
            head: from + replacement.length - (selectedText ? 0 : 1),
          },
        });
      }
      break;
    }

    case "strike": {
      if (selectedText.startsWith("~~") && selectedText.endsWith("~~") && selectedText.length >= 4) {
        // Unwrap strikethrough
        dispatch({
          changes: { from, to, insert: selectedText.slice(2, -2) },
          selection: { anchor: from, head: to - 4 },
        });
      } else {
        const replacement = `~~${selectedText || "strikethrough"}~~`;
        dispatch({
          changes: { from, to, insert: replacement },
          selection: {
            anchor: from + (selectedText ? 0 : 2),
            head: from + replacement.length - (selectedText ? 0 : 2),
          },
        });
      }
      break;
    }

    case "code": {
      if (selectedText.includes("\n")) {
        const replacement = `\`\`\`\n${selectedText || "code"}\n\`\`\``;
        dispatch({
          changes: { from, to, insert: replacement },
          selection: { anchor: from + 4, head: from + 4 + (selectedText ? selectedText.length : 4) },
        });
      } else if (selectedText.startsWith("`") && selectedText.endsWith("`") && selectedText.length >= 2) {
        dispatch({
          changes: { from, to, insert: selectedText.slice(1, -1) },
          selection: { anchor: from, head: to - 2 },
        });
      } else {
        const replacement = `\`${selectedText || "code"}\``;
        dispatch({
          changes: { from, to, insert: replacement },
          selection: {
            anchor: from + (selectedText ? 0 : 1),
            head: from + replacement.length - (selectedText ? 0 : 1),
          },
        });
      }
      break;
    }

    case "h1":
    case "h2":
    case "h3":
    case "quote":
    case "bulletList":
    case "orderedList":
    case "taskList": {
      const prefixes: Record<string, string> = {
        h1: "# ",
        h2: "## ",
        h3: "### ",
        quote: "> ",
        bulletList: "- ",
        orderedList: "1. ",
        taskList: "- [ ] ",
      };
      const prefix = prefixes[type];
      const line = state.doc.lineAt(from);
      const lineText = line.text;

      // Remove existing header or list prefixes if any
      const cleaned = lineText.replace(/^(\s*)(#{1,6}\s+|>\s+|-\s+\[[ x]\]\s+|-\s+|\d+\.\s+)/, "$1");
      const indentedMatch = lineText.match(/^(\s*)/);
      const indent = indentedMatch ? indentedMatch[1] : "";

      let isAlreadySame = false;
      if (type === "bulletList") {
        isAlreadySame = /^\s*-\s+(?!\[[ x]\])/.test(lineText);
      } else if (type === "taskList") {
        isAlreadySame = /^\s*-\s+\[[ x]\]\s+/.test(lineText);
      } else if (type === "orderedList") {
        isAlreadySame = /^\s*\d+\.\s+/.test(lineText);
      } else if (type === "quote") {
        isAlreadySame = /^\s*>\s+/.test(lineText);
      } else if (type === "h1") {
        isAlreadySame = /^\s*#\s+/.test(lineText);
      } else if (type === "h2") {
        isAlreadySame = /^\s*##\s+/.test(lineText);
      } else if (type === "h3") {
        isAlreadySame = /^\s*###\s+/.test(lineText);
      }

      let newLineText: string;
      if (isAlreadySame) {
        newLineText = cleaned;
      } else {
        newLineText = indent + prefix + cleaned.trimStart();
      }

      dispatch({
        changes: { from: line.from, to: line.to, insert: newLineText },
        selection: { anchor: Math.min(line.from + newLineText.length, state.doc.length + (newLineText.length - lineText.length)) },
      });
      break;
    }

    case "horizontalRule": {
      const line = state.doc.lineAt(to);
      const replacement = `\n\n---\n\n`;
      dispatch({
        changes: { from: line.to, to: line.to, insert: replacement },
        selection: { anchor: line.to + replacement.length },
      });
      break;
    }

    case "link": {
      if (selectedText) {
        const replacement = `[${selectedText}](https://)`;
        dispatch({
          changes: { from, to, insert: replacement },
          selection: { anchor: from + selectedText.length + 3, head: from + replacement.length - 1 },
        });
      } else {
        const replacement = `[Link title](https://)`;
        dispatch({
          changes: { from, to, insert: replacement },
          selection: { anchor: from + 1, head: from + 11 },
        });
      }
      break;
    }

    case "table": {
      const tableTemplate = `\n\n| Column 1 | Column 2 | Column 3 |\n| :--- | :--- | :--- |\n| Value 1 | Value 2 | Value 3 |\n| Item A | Item B | Item C |\n\n`;
      const line = state.doc.lineAt(to);
      dispatch({
        changes: { from: line.to, to: line.to, insert: tableTemplate },
        selection: { anchor: line.to + tableTemplate.length },
      });
      break;
    }
  }

  view.focus();
}
