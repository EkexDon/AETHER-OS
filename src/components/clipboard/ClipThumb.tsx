import { useEffect, useMemo } from "react";
import { Braces, Image as ImageIcon, Link2, Palette, Type, type LucideIcon } from "lucide-react";
import type { ClipItem, ClipKind } from "../../types";
import { useClipboardStore } from "../../lib/clipboardStore";
import { parseColor, toCss } from "../../lib/clipboard/color";
import { cx } from "../../ui";

/** Lucide icon per clip kind. */
export const KIND_ICONS: Record<ClipKind, LucideIcon> = {
  text: Type,
  url: Link2,
  code: Braces,
  image: ImageIcon,
  color: Palette,
};

/** A swatch for a color clip (checkerboard behind translucent colors). */
export function ColorSwatch({ value, size = "sm" }: { value: string; size?: "sm" | "lg" }) {
  const color = useMemo(() => parseColor(value), [value]);
  return (
    <span className={cx("clip-swatch", `clip-swatch-${size}`)} aria-hidden="true">
      <span className="clip-swatch-fill" style={color ? { background: toCss(color) } : undefined} />
    </span>
  );
}

/**
 * The leading visual of a list row: an image thumbnail, a color swatch or
 * the kind icon in a soft tile.
 */
export function ClipThumb({ item }: { item: ClipItem }) {
  const thumb = useClipboardStore((s) => (item.kind === "image" ? s.images[`${item.id}:thumb`] : undefined));
  const loadImage = useClipboardStore((s) => s.loadImage);

  useEffect(() => {
    if (item.kind === "image" && !thumb) void loadImage(item.id, true);
  }, [item.id, item.kind, thumb, loadImage]);

  if (item.kind === "color") {
    return (
      <span className="clip-thumb">
        <ColorSwatch value={item.content} />
      </span>
    );
  }
  if (item.kind === "image" && thumb) {
    return (
      <span className="clip-thumb is-image">
        <img src={thumb} alt="" draggable={false} />
      </span>
    );
  }
  const Icon = KIND_ICONS[item.kind];
  return (
    <span className={cx("clip-thumb", `is-${item.kind}`)}>
      <Icon size={14} strokeWidth={1.9} />
    </span>
  );
}
