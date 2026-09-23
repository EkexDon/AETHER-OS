import { useEffect, useState, useMemo, type MouseEvent, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import mermaid from "mermaid";
import { ExternalLink, FileWarning, ImageOff } from "lucide-react";
import { useAetherStore } from "../lib/store";
import { useThemeStore, type ResolvedTheme } from "../lib/theme";
import { agentOpenUrl } from "../lib/ipc";
import { humanizeError } from "../lib/sync/format";
import { classifyLink, findLinkedNote, findWikilinkNote } from "../lib/markdown/links";
import {
  fileName,
  hasUrlScheme,
  isInlineImageSrc,
  isRemoteSrc,
  mediaKindOf,
  type MediaKind,
} from "../lib/markdown/assets";
import { remarkWikiEmbeds } from "../lib/markdown/remarkEmbeds";
import { dataUrlBytes, loadVaultAsset, peekVaultAsset, type LoadedAsset } from "../lib/vaultAssets";
import { Spinner, toast } from "../ui";

let mermaidTheme: ResolvedTheme | null = null;

/** (Re)configure mermaid for the active app theme. */
function ensureMermaidTheme(theme: ResolvedTheme) {
  if (mermaidTheme === theme) return;
  mermaidTheme = theme;
  mermaid.initialize({
    startOnLoad: false,
    // DOMPurify-sanitised SVG, no click handlers or HTML labels from the diagram source.
    securityLevel: "strict",
    theme: theme === "light" ? "neutral" : "dark",
    fontFamily: '"IBM Plex Sans Variable", -apple-system, sans-serif',
    fontSize: 13,
  });
}

ensureMermaidTheme(useThemeStore.getState().resolved);

function MermaidBlock({ code }: { code: string }) {
  const [svg, setSvg] = useState("");
  const [error, setError] = useState("");
  const id = useMemo(() => `mermaid-${Math.random().toString(36).slice(2, 10)}`, []);
  const theme = useThemeStore((s) => s.resolved);

  useEffect(() => {
    let active = true;
    ensureMermaidTheme(theme);
    const render = async () => {
      if (!code.trim()) {
        setSvg("");
        setError("");
        return;
      }
      try {
        const { svg: s } = await mermaid.render(id, code);
        if (active) {
          setSvg(s);
          setError("");
        }
      } catch (err: unknown) {
        if (active) setError(err instanceof Error && err.message ? err.message : "Syntax error");
      }
    };
    render();
    return () => {
      active = false;
    };
  }, [code, id, theme]);

  if (error) return <div className="md-mermaid-error">{error}</div>;
  if (!svg) return null;
  // Mermaid's own output (securityLevel "strict" runs it through DOMPurify).
  return <div className="md-mermaid" dangerouslySetInnerHTML={{ __html: svg }} />;
}

const KIND_LABEL: Record<MediaKind, string> = { image: "image", video: "video", audio: "audio", pdf: "PDF" };

/** Loading and "unavailable" states share one inline box so text never jumps around. */
function MediaState({
  kind,
  name,
  state,
  detail,
  action,
}: {
  kind: MediaKind;
  name: string;
  state: "loading" | "error" | "blocked";
  detail?: string;
  action?: ReactNode;
}) {
  const label = KIND_LABEL[kind];
  const Icon = kind === "image" ? ImageOff : FileWarning;
  return (
    <span
      className={`md-media-state is-${state}`}
      role={state === "loading" ? "status" : "img"}
      aria-label={
        state === "loading" ? `Loading ${label} ${name}` : `${label} ${state === "blocked" ? "not loaded" : "unavailable"}: ${name}`
      }
      title={detail}
    >
      {state === "loading" ? <Spinner size={14} /> : <Icon size={16} aria-hidden="true" />}
      <span className="md-media-state-text" aria-hidden="true">
        {state === "loading"
          ? `Loading ${label}…`
          : state === "blocked"
            ? `Remote ${label}`
            : `${label.charAt(0).toUpperCase()}${label.slice(1)} unavailable`}
      </span>
      <span className="md-media-name" aria-hidden="true">
        {name}
      </span>
      {action}
    </span>
  );
}

/** A Blob URL for video/audio/PDF (large `data:` URLs are slow in media elements); falls back to the data URL. */
function useBlobUrl(asset: LoadedAsset | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!asset || asset.kind === "image") {
      setUrl(null);
      return;
    }
    if (typeof URL.createObjectURL !== "function") {
      setUrl(asset.dataUrl);
      return;
    }
    let objectUrl: string;
    try {
      objectUrl = URL.createObjectURL(new Blob([dataUrlBytes(asset.dataUrl)], { type: asset.mime }));
    } catch {
      setUrl(asset.dataUrl);
      return;
    }
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [asset]);
  return url;
}

type AssetState = { status: "loading" } | { status: "ready"; asset: LoadedAsset } | { status: "error"; message: string };

function useVaultAsset(ref: string, notePath: string | null, vaultRoot: string | null): AssetState {
  const [state, setState] = useState<AssetState>(() => {
    const hit = peekVaultAsset(ref, notePath, vaultRoot);
    return hit ? { status: "ready", asset: hit } : { status: "loading" };
  });
  useEffect(() => {
    let alive = true;
    const hit = peekVaultAsset(ref, notePath, vaultRoot);
    if (hit) {
      setState({ status: "ready", asset: hit });
      return;
    }
    setState({ status: "loading" });
    loadVaultAsset(ref, notePath, vaultRoot).then(
      (asset) => alive && setState({ status: "ready", asset }),
      (error: unknown) => alive && setState({ status: "error", message: humanizeError(error instanceof Error ? error.message : String(error)) })
    );
    return () => {
      alive = false;
    };
  }, [ref, notePath, vaultRoot]);
  return state;
}

interface MediaProps {
  src: string;
  alt: string;
  width?: number;
  height?: number;
}

function RenderedMedia({ kind, url, alt, name, width, height, onBroken }: {
  kind: MediaKind;
  url: string;
  alt: string;
  name: string;
  width?: number;
  height?: number;
  onBroken: () => void;
}) {
  switch (kind) {
    case "video":
      return (
        <span className="md-video-wrapper">
          <video src={url} controls preload="metadata" className="md-video" aria-label={alt || name} width={width} onError={onBroken} />
        </span>
      );
    case "audio":
      return <audio src={url} controls preload="metadata" className="md-audio" aria-label={alt || name} onError={onBroken} />;
    case "pdf":
      return (
        <span className="md-pdf-wrapper">
          <embed src={url} type="application/pdf" className="md-pdf" title={alt || name} />
        </span>
      );
    default:
      return <img src={url} alt={alt} title={alt || undefined} className="md-image" loading="lazy" width={width} height={height} onError={onBroken} />;
  }
}

/** A vault file: resolved and loaded through `cmd_read_vault_asset`, cached by path. */
function VaultMedia({ src, alt, width, height, notePath }: MediaProps & { notePath: string | null }) {
  const vaultRoot = useAetherStore((s) => s.vaultPath);
  const state = useVaultAsset(src, notePath, vaultRoot);
  const asset = state.status === "ready" ? state.asset : null;
  const blobUrl = useBlobUrl(asset);
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [asset]);
  const name = fileName(src) || src;
  const guessed = mediaKindOf(src) ?? "image";

  if (state.status === "loading") return <MediaState kind={guessed} name={name} state="loading" />;
  if (state.status === "error") return <MediaState kind={guessed} name={name} state="error" detail={state.message} />;
  const kind = state.asset.kind ?? guessed;
  if (broken) return <MediaState kind={kind} name={name} state="error" detail="The file could not be decoded." />;
  const url = kind === "image" ? state.asset.dataUrl : blobUrl;
  if (!url) return <MediaState kind={kind} name={name} state="loading" />;
  return <RenderedMedia kind={kind} url={url} alt={alt} name={name} width={width} height={height} onBroken={() => setBroken(true)} />;
}

/** A web image/video. Loaded only when the content is trusted to do so, otherwise on request. */
function RemoteMedia({ src, alt, width, height, allowed }: MediaProps & { allowed: boolean }) {
  const [show, setShow] = useState(allowed);
  const [broken, setBroken] = useState(false);
  const kind = mediaKindOf(src) ?? "image";
  let host = src;
  try {
    host = new URL(src).host;
  } catch {
    // Keep the raw source as the label.
  }
  if (broken) return <MediaState kind={kind} name={host} state="error" detail={src} />;
  if (!show) {
    return (
      <MediaState
        kind={kind}
        name={host}
        state="blocked"
        detail={`${src}\nWeb media is not loaded automatically in AI and plugin content.`}
        action={
          <button type="button" className="md-media-load" onClick={() => setShow(true)}>
            Load
          </button>
        }
      />
    );
  }
  return <RenderedMedia kind={kind} url={src} alt={alt} name={host} width={width} height={height} onBroken={() => setBroken(true)} />;
}

function MediaEmbed({
  src,
  alt,
  width,
  height,
  notePath,
  remoteMedia,
}: MediaProps & { notePath: string | null; remoteMedia: boolean }) {
  const name = fileName(src) || alt || "embed";
  if (!src.trim()) return <MediaState kind="image" name={alt || "embed"} state="error" detail="The embed has no source." />;
  if (isInlineImageSrc(src)) return <img src={src} alt={alt} className="md-image" width={width} height={height} />;
  if (isRemoteSrc(src)) return <RemoteMedia src={src} alt={alt} width={width} height={height} allowed={remoteMedia} />;
  if (hasUrlScheme(src)) {
    return <MediaState kind="image" name={name} state="error" detail="Only vault files and web images can be embedded." />;
  }
  return <VaultMedia src={src} alt={alt} width={width} height={height} notePath={notePath} />;
}

/**
 * A link: web and mail links open in the system browser through
 * `cmd_agent_open_url` (the webview itself never navigates), links to
 * notes of this vault open them in the editor, and everything else
 * (`javascript:`, `data:`, `file:`, unknown notes) is rendered as text.
 */
function MarkdownLink({
  href,
  title,
  notePath,
  wikilink,
  children,
}: {
  href: string | undefined;
  title?: string;
  notePath: string | null;
  /** Target of a `[[wikilink]]` (from `remarkWikiEmbeds`). */
  wikilink?: string;
  children: ReactNode;
}) {
  const vaultNotes = useAetherStore((s) => s.vaultNotes);
  const vaultPath = useAetherStore((s) => s.vaultPath);
  if (wikilink !== undefined) {
    const note = findWikilinkNote(wikilink, vaultPath, vaultNotes);
    if (!note) {
      return (
        <span className="md-link is-inert is-missing" title={`No note named “${wikilink}” in this vault`}>
          {children}
        </span>
      );
    }
    return (
      <a
        href={`#${encodeURIComponent(note.name)}`}
        title={`Open ${note.name}`}
        className="md-link is-wikilink"
        onClick={(event) => {
          event.preventDefault();
          const store = useAetherStore.getState();
          store.selectNote(note.path);
          store.setView("editor");
        }}
      >
        {children}
      </a>
    );
  }
  const target = classifyLink(href);

  if (target.kind === "external") {
    const open = (event: MouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
      agentOpenUrl(target.url).catch((error: unknown) =>
        toast.error("Could not open the link", { description: humanizeError(error instanceof Error ? error.message : String(error)) })
      );
    };
    return (
      <a
        href={target.url}
        title={title ?? target.url}
        className="md-link is-external"
        rel="noopener noreferrer"
        onClick={open}
        onAuxClick={(event) => {
          if (event.button === 1) open(event);
        }}
      >
        {children}
        <ExternalLink size={14} className="md-link-icon" aria-hidden="true" />
      </a>
    );
  }
  if (target.kind === "note") {
    const note = findLinkedNote(target.path, notePath, vaultPath, vaultNotes);
    if (note) {
      return (
        <a
          href={`#${encodeURIComponent(note.name)}`}
          title={title ?? `Open ${note.name}`}
          className="md-link"
          onClick={(event) => {
            event.preventDefault();
            const store = useAetherStore.getState();
            store.selectNote(note.path);
            store.setView("editor");
          }}
        >
          {children}
        </a>
      );
    }
  }
  const why =
    target.kind === "blocked"
      ? "Link removed: only web, mail and note links are allowed"
      : target.kind === "anchor"
        ? undefined
        : "Not a note in this vault";
  return (
    <span className="md-link is-inert" title={why}>
      {children}
    </span>
  );
}

/** The bits of a hast node the renderer inspects (avoids a direct `hast` dependency). */
interface HastLike {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastLike[];
}

/** Plain text of a hast subtree. */
function hastText(node: HastLike): string {
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(hastText).join("");
}

/** Language of a fenced block (`language-ts` → `ts`) from its `<code>` element. */
export function fenceLanguage(code: HastLike | undefined): string | null {
  const raw = code?.properties?.className;
  const classes = Array.isArray(raw) ? raw.map(String) : typeof raw === "string" ? raw.split(/\s+/) : [];
  const match = classes.map((c) => /^language-(.+)$/.exec(c)).find(Boolean);
  return match ? match[1] : null;
}

/** Keep inline `data:image/…` sources; every other URL gets react-markdown's safe default. */
export function markdownUrlTransform(url: string, key: string): string {
  if (key === "src" && isInlineImageSrc(url)) return url;
  return defaultUrlTransform(url);
}

function dimension(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 && n < 10_000 ? n : undefined;
}

/** Props of {@link MarkdownRenderer}. */
export interface MarkdownRendererProps {
  content: string;
  /** Absolute path of the note being shown: relative embeds and note links resolve against its folder. */
  notePath?: string | null;
  /** Render embedded images, video, audio and PDFs (default `true`; plugin panels pass `false`). */
  allowMedia?: boolean;
  /** Load `https://` images without asking (default `false`: AI and plugin output must not beacon out). */
  remoteMedia?: boolean;
}

/**
 * Markdown (GFM) for chat answers, AI notes, previews and plugin panels.
 * Raw HTML is shown as text (no `rehype-raw`); inline code renders as
 * `<code>`; fenced blocks as `<pre><code>` (or a mermaid diagram), so no
 * block element ever lands inside a paragraph. Vault media — `![](x.png)`
 * and Obsidian `![[x.png]]` — load through `cmd_read_vault_asset`.
 */
export function MarkdownRenderer({ content, notePath = null, allowMedia = true, remoteMedia = false }: MarkdownRendererProps) {
  return (
    <div className="md-render">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkWikiEmbeds]}
        urlTransform={markdownUrlTransform}
        components={{
          img: ({ src, alt, node }) => {
            const props = (node as HastLike | undefined)?.properties ?? {};
            const source = typeof src === "string" ? src : "";
            if (!allowMedia) return <span className="md-media-alt">{alt || fileName(source)}</span>;
            return (
              <MediaEmbed
                src={source}
                alt={alt || ""}
                width={dimension(props.width)}
                height={dimension(props.height)}
                notePath={notePath}
                remoteMedia={remoteMedia}
              />
            );
          },
          pre: ({ node, children }) => {
            const first = (node as HastLike | undefined)?.children?.find((c) => c.type === "element");
            if (first?.tagName === "code" && fenceLanguage(first) === "mermaid") {
              return <MermaidBlock code={hastText(first)} />;
            }
            return <pre className="md-code-block">{children}</pre>;
          },
          code: ({ className, children }) => <code className={className}>{children}</code>,
          a: ({ href, title, children, node }) => {
            const wikilink = (node as HastLike | undefined)?.properties?.dataWikilink;
            return (
              <MarkdownLink
                href={href}
                title={title}
                notePath={notePath}
                wikilink={typeof wikilink === "string" ? wikilink : undefined}
              >
                {children}
              </MarkdownLink>
            );
          },
          table: ({ children }) => (
            <div className="md-table-scroll">
              <table className="md-table">{children}</table>
            </div>
          ),
          input: ({ checked }) => <input type="checkbox" checked={!!checked} disabled readOnly className="md-checkbox" />,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
