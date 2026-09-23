/**
 * Briefly highlight one block of the note canvas (e.g. the task opened from
 * Note Tasks). The highlight is a ProseMirror node decoration, so it
 * survives re-renders and follows the block while the user types; it is
 * removed after {@link LINE_FLASH_MS}.
 */
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

/** How long a flashed block stays highlighted. */
export const LINE_FLASH_MS = 1800;
/** CSS class of the highlighted block (styled in `editor.css`). */
export const LINE_FLASH_CLASS = "is-line-flash";

const key = new PluginKey<DecorationSet>("lineFlash");

type FlashMeta = { pos: number } | { clear: true };

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    lineFlash: {
      /** Highlight the node that starts at `pos` for a moment. */
      flashBlock: (pos: number) => ReturnType;
    };
  }
}

/** The editor extension providing `flashBlock(pos)`. */
export const LineFlash = Extension.create({
  name: "lineFlash",

  addCommands() {
    return {
      flashBlock:
        (pos: number) =>
        ({ tr, dispatch, editor }) => {
          const node = tr.doc.nodeAt(pos);
          if (!node) return false;
          if (dispatch) {
            tr.setMeta(key, { pos } satisfies FlashMeta);
            window.setTimeout(() => {
              if (!editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(key, { clear: true } satisfies FlashMeta));
            }, LINE_FLASH_MS);
          }
          return true;
        },
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, set) {
            const meta = tr.getMeta(key) as FlashMeta | undefined;
            if (meta && "clear" in meta) return DecorationSet.empty;
            if (meta && "pos" in meta) {
              const node = tr.doc.nodeAt(meta.pos);
              if (!node) return DecorationSet.empty;
              return DecorationSet.create(tr.doc, [
                Decoration.node(meta.pos, meta.pos + node.nodeSize, { class: LINE_FLASH_CLASS }),
              ]);
            }
            return set.map(tr.mapping, tr.doc);
          },
        },
        props: {
          decorations(state) {
            return key.getState(state);
          },
        },
      }),
    ];
  },
});
