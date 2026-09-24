/**
 * Images in the note editor load from the vault. The webview cannot read
 * files, so a relative `![alt](attachments/photo.png)` would otherwise be
 * requested from the app's own origin and show as a broken image. This
 * node view resolves the source like the Markdown renderer does
 * (`loadVaultAsset`: note folder → vault root → attachment folders) and
 * shows a placeholder while loading or when the file is missing. The
 * node's `src` attribute — and so the saved Markdown — is never changed.
 *
 * {@link createVaultImageView} is shared with `![[image.png]]` embeds.
 */
import Image from "@tiptap/extension-image";
import type { Node as PmNode } from "@tiptap/pm/model";
import { useAetherStore } from "../store";
import { fileName, hasUrlScheme, isInlineImageSrc, isRemoteSrc } from "../markdown/assets";
import { loadVaultAsset, peekVaultAsset } from "../vaultAssets";
import { escapeMarkdownText, formatDestination, type SerializerState } from "./markdownSerializer";

/** Where the editor should load `src` from: directly, from the vault, or not at all. */
export function imageSourceKind(src: string): "direct" | "vault" | "blocked" {
  const value = src.trim();
  if (!value) return "blocked";
  if (isRemoteSrc(value) || isInlineImageSrc(value)) return "direct";
  if (hasUrlScheme(value)) return "blocked";
  return "vault";
}

function setState(dom: HTMLElement, state: "loading" | "ready" | "error", label: string, detail?: string) {
  dom.dataset.state = state;
  const placeholder = dom.querySelector<HTMLElement>(".editor-image-state")!;
  placeholder.hidden = state === "ready";
  placeholder.textContent = state === "loading" ? `Loading ${label}…` : state === "error" ? `Image unavailable · ${label}` : "";
  if (detail) placeholder.title = detail;
  else placeholder.removeAttribute("title");
}

/** An image element that loads its source from the vault (or the web). */
export interface VaultImageView {
  dom: HTMLElement;
  img: HTMLImageElement;
  /** Show `src`; loading starts only when the source changed. */
  render(src: string, alt: string, title?: string | null): void;
  /** Ignore loads that finish after the view is gone. */
  destroy(): void;
}

/** The `.editor-image` wrapper with its image and loading/error placeholder. */
export function createVaultImageView(): VaultImageView {
  const dom = document.createElement("span");
  dom.className = "editor-image";
  dom.contentEditable = "false";
  const img = document.createElement("img");
  img.draggable = false;
  const placeholder = document.createElement("span");
  placeholder.className = "editor-image-state";
  dom.append(img, placeholder);
  let current: string | null = null;
  let generation = 0;

  const render = (src: string, alt: string, title?: string | null) => {
    img.alt = alt;
    if (title) img.title = title;
    else img.removeAttribute("title");
    if (src === current) return;
    current = src;
    const token = ++generation;
    const label = alt || fileName(src) || "image";
    img.onerror = () => {
      if (token === generation) setState(dom, "error", label, "The image could not be decoded.");
    };
    img.onload = () => {
      if (token === generation) setState(dom, "ready", label);
    };
    switch (imageSourceKind(src)) {
      case "direct":
        setState(dom, "loading", label);
        img.src = src;
        return;
      case "blocked":
        img.removeAttribute("src");
        setState(dom, "error", label, "Only vault files and web images can be shown.");
        return;
      default: {
        const { selectedNotePath, vaultPath } = useAetherStore.getState();
        const cached = peekVaultAsset(src, selectedNotePath, vaultPath);
        if (cached) {
          img.src = cached.dataUrl;
          setState(dom, "ready", label);
          return;
        }
        img.removeAttribute("src");
        setState(dom, "loading", label);
        loadVaultAsset(src, selectedNotePath, vaultPath).then(
          (asset) => {
            if (token !== generation) return;
            img.src = asset.dataUrl;
          },
          (error: unknown) => {
            if (token === generation) setState(dom, "error", label, error instanceof Error ? error.message : String(error));
          }
        );
      }
    }
  };

  return {
    dom,
    img,
    render,
    destroy: () => {
      generation++;
    },
  };
}

/** `![alt](src "title")` for an image node's attributes. */
export function imageMarkdown(attrs: { src?: unknown; alt?: unknown; title?: unknown }): string {
  const alt = escapeMarkdownText(String(attrs.alt ?? "")).replace(/(^|[^\\])([[\]])/g, "$1\\$2");
  const title = attrs.title ? ` "${String(attrs.title).replace(/["\\]/g, "\\$&")}"` : "";
  return `![${alt}](${formatDestination(String(attrs.src ?? ""))}${title})`;
}

/** tiptap's Image with a vault-aware node view (same schema) and a serializer that keeps the next block apart. */
export const VaultImage = Image.extend({
  addStorage() {
    return {
      markdown: {
        serialize(state: SerializerState, node: PmNode) {
          state.write(imageMarkdown(node.attrs));
          if (node.isBlock) state.closeBlock(node);
        },
        parse: {},
      },
    };
  },
  addNodeView() {
    return ({ node }) => {
      const view = createVaultImageView();
      const render = (n: PmNode) => view.render(String(n.attrs.src ?? ""), String(n.attrs.alt ?? ""), n.attrs.title ? String(n.attrs.title) : null);
      render(node);
      return {
        dom: view.dom,
        update: (updated) => {
          if (updated.type !== node.type) return false;
          render(updated);
          return true;
        },
        destroy: view.destroy,
      };
    };
  },
});
