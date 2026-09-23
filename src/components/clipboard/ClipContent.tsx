import { useEffect, useMemo, useState } from "react";
import { Copy, ImageOff } from "lucide-react";
import type { ClipItem } from "../../types";
import { useClipboardStore } from "../../lib/clipboardStore";
import { parseColor, toHex, toHsl, toRgb } from "../../lib/clipboard/color";
import { displayPreview, formatBytes, urlHost, urlHref } from "../../lib/clipboard/format";
import { tokenize } from "../../lib/clipboard/highlight";
import { browserOpen } from "../../lib/ipc/browser";
import { IconButton, Spinner, toast, useToast } from "../../ui";
import { ColorSwatch } from "./ClipThumb";

/** Characters rendered in the detail pane; the rest is available via Copy. */
export const MAX_RENDER_CHARS = 100_000;
/** Code longer than this is shown without highlighting (keeps typing snappy). */
const MAX_HIGHLIGHT_CHARS = 40_000;

function Truncation({ shown, total }: { shown: number; total: number }) {
  if (shown >= total) return null;
  return (
    <p className="clip-content-truncated">
      Showing the first {shown.toLocaleString("en-US")} of {total.toLocaleString("en-US")} characters — Copy puts
      everything on the clipboard.
    </p>
  );
}

function CodeBlock({ code }: { code: string }) {
  const shown = code.length > MAX_RENDER_CHARS ? code.slice(0, MAX_RENDER_CHARS) : code;
  const tokens = useMemo(() => (shown.length <= MAX_HIGHLIGHT_CHARS ? tokenize(shown) : null), [shown]);
  return (
    <>
      <pre className="clip-code" tabIndex={0} aria-label="Code">
        <code>
          {tokens
            ? tokens.map((t, i) =>
                t.type === "plain" ? (
                  t.text
                ) : (
                  <span key={i} className={`clip-tok-${t.type}`}>
                    {t.text}
                  </span>
                )
              )
            : shown}
        </code>
      </pre>
      <Truncation shown={shown.length} total={code.length} />
    </>
  );
}

function ColorDetail({ value }: { value: string }) {
  const toast = useToast();
  const color = useMemo(() => parseColor(value), [value]);
  const formats = color
    ? [
        { label: "HEX", value: toHex(color) },
        { label: "RGB", value: toRgb(color) },
        { label: "HSL", value: toHsl(color) },
      ]
    : [];
  const copyFormat = async (text: string) => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("The clipboard is not available here.");
      await navigator.clipboard.writeText(text);
      toast.success("Copied", { description: text });
    } catch (e) {
      toast.error("Could not copy", { description: e instanceof Error ? e.message : String(e) });
    }
  };
  return (
    <div className="clip-color">
      <ColorSwatch value={value} size="lg" />
      <div className="clip-color-value mono">{value.trim()}</div>
      {formats.length > 0 && (
        <dl className="clip-color-formats">
          {formats.map((f) => (
            <div key={f.label} className="clip-color-format">
              <dt>{f.label}</dt>
              <dd className="mono">{f.value}</dd>
              <IconButton size="sm" label={`Copy ${f.label}`} icon={<Copy size={14} />} onClick={() => void copyFormat(f.value)} />
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

function ImageDetail({ item }: { item: ClipItem }) {
  const url = useClipboardStore((s) => s.images[`${item.id}:full`]);
  const loadImage = useClipboardStore((s) => s.loadImage);
  // Keyed by clip id, so switching clips resets the error.
  const [failedId, setFailedId] = useState<string | null>(null);
  const failed = failedId === item.id;

  useEffect(() => {
    if (url) return;
    let active = true;
    void loadImage(item.id, false).then((loaded) => {
      if (active && !loaded) setFailedId(item.id);
    });
    return () => {
      active = false;
    };
  }, [item.id, url, loadImage]);

  if (failed) {
    return (
      <div className="clip-image-missing">
        <ImageOff size={18} />
        <span>The image file could not be loaded.</span>
      </div>
    );
  }
  return (
    <figure className="clip-image">
      {url ? (
        <img src={url} alt={`Copied image, ${displayPreview(item)}`} draggable={false} />
      ) : (
        <div className="clip-image-loading">
          <Spinner size={14} label="Loading image" />
        </div>
      )}
      <figcaption>
        {displayPreview(item)} px · {formatBytes(item.byte_len)} PNG
      </figcaption>
    </figure>
  );
}

/** Open a link clip in the system browser (toasts on failure). */
export async function openClipLink(href: string): Promise<void> {
  try {
    await browserOpen(href);
  } catch (e) {
    toast.error("Could not open the link", { description: e instanceof Error ? e.message : String(e) });
  }
}

function UrlDetail({ value }: { value: string }) {
  const host = urlHost(value);
  const href = urlHref(value);
  return (
    <div className="clip-url">
      {host && <div className="clip-url-host">{host}</div>}
      {href ? (
        <a
          className="clip-url-link"
          href={href}
          rel="noreferrer noopener"
          onClick={(e) => {
            e.preventDefault();
            void openClipLink(href);
          }}
        >
          {value.trim()}
        </a>
      ) : (
        <div className="clip-url-link">{value.trim()}</div>
      )}
    </div>
  );
}

/** Full rendering of a clip by kind. */
export function ClipContent({ item }: { item: ClipItem }) {
  switch (item.kind) {
    case "code":
      return <CodeBlock code={item.content} />;
    case "color":
      return <ColorDetail value={item.content} />;
    case "image":
      return <ImageDetail item={item} />;
    case "url":
      return <UrlDetail value={item.content} />;
    default: {
      const shown = item.content.length > MAX_RENDER_CHARS ? item.content.slice(0, MAX_RENDER_CHARS) : item.content;
      return (
        <>
          <div className="clip-text">{shown}</div>
          <Truncation shown={shown.length} total={item.content.length} />
        </>
      );
    }
  }
}
