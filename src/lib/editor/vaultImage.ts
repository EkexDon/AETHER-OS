/**
 * Images in the note editor load from the vault. The webview cannot read
 * files, so a relative `![alt](attachments/photo.png)` would otherwise be
 * requested from the app's own origin and show as a broken image. This
 * node view resolves the source like the Markdown renderer does
 * (`loadVaultAsset`: note folder → vault root → attachment folders) and
 * shows a placeholder while loading or when the file is missing. The
 * node's `src` attribute — and so the saved Markdown — is never changed.
 */
import Image from "@tiptap/extension-image";
import type { Node as PmNode } from "@tiptap/pm/model";
import { useAetherStore } from "../store";
import { fileName, hasUrlScheme, isInlineImageSrc, isRemoteSrc } from "../markdown/assets";
import { loadVaultAsset, peekVaultAsset } from "../vaultAssets";

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

/** tiptap's Image with a vault-aware node view (same schema and Markdown output). */
export const VaultImage = Image.extend({
  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement("span");
      dom.className = "editor-image";
      dom.contentEditable = "false";
      const img = document.createElement("img");
      img.draggable = false;
      const placeholder = document.createElement("span");
      placeholder.className = "editor-image-state";
      dom.append(img, placeholder);
      let current = "";
      let generation = 0;

      const render = (n: PmNode) => {
        const src = String(n.attrs.src ?? "");
        const alt = String(n.attrs.alt ?? "");
        img.alt = alt;
        if (n.attrs.title) img.title = String(n.attrs.title);
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

      render(node);
      return {
        dom,
        update: (updated) => {
          if (updated.type !== node.type) return false;
          render(updated);
          return true;
        },
        destroy: () => {
          generation++;
        },
      };
    };
  },
});
