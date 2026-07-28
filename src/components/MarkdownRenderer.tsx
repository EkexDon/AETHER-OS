import React, { useEffect, useRef, useState, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import mermaid from "mermaid";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useAetherStore } from "../lib/store";

mermaid.initialize({
  startOnLoad: false,
  theme: "dark",
  fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif",
  fontSize: 13,
});

function resolveAssetSrc(relPath: string, vaultPath: string | null): string {
  if (!relPath) return "";
  if (relPath.startsWith("http") || relPath.startsWith("data:") || relPath.startsWith("asset://")) {
    return relPath;
  }
  if (!vaultPath) return relPath;
  const sep = vaultPath.includes("\\") ? "\\" : "/";
  const absPath = `${vaultPath}${sep}${relPath}`;
  try {
    return convertFileSrc(absPath);
  } catch {
    return relPath;
  }
}

function MermaidBlock({ code }: { code: string }) {
  const [svg, setSvg] = useState("");
  const [error, setError] = useState("");
  const id = useMemo(() => `mermaid-${Math.random().toString(36).slice(2, 10)}`, []);

  useEffect(() => {
    let active = true;
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
      } catch (err: any) {
        if (active) setError(err?.message || "Syntax error");
      }
    };
    render();
    return () => { active = false; };
  }, [code, id]);

  if (error) return <div className="md-mermaid-error">{error}</div>;
  if (!svg) return null;
  return <div className="md-mermaid" dangerouslySetInnerHTML={{ __html: svg }} />;
}

function MediaRenderer({ src, alt }: { src: string; alt: string }) {
  const { vaultPath } = useAetherStore();
  const resolved = resolveAssetSrc(src, vaultPath);

  if (/\.pdf$/i.test(src)) {
    return (
      <div className="md-pdf-wrapper">
        <iframe
          src={resolved}
          className="md-pdf"
          title={alt || src.split("/").pop() || "PDF"}
          loading="lazy"
        />
      </div>
    );
  }

  if (/\.(mp4|webm|mov)$/i.test(src)) {
    return (
      <div className="md-video-wrapper">
        <video src={resolved} controls preload="metadata" className="md-video" />
      </div>
    );
  }

  return <img src={resolved} alt={alt} className="md-image" loading="lazy" />;
}

export function MarkdownRenderer({ content }: { content: string }) {
  return (
    <div className="md-render">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          img: ({ src, alt }) => <MediaRenderer src={src || ""} alt={alt || ""} />,
          code: ({ className, children }) => {
            const match = /language-(\w+)/.exec(className || "");
            const lang = match?.[1];
            const code = String(children);

            if (lang === "mermaid") {
              return <MermaidBlock code={code} />;
            }

            return (
              <pre className="md-code-block">
                <code className={className}>{children}</code>
              </pre>
            );
          },
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer" className="md-link">
              {children}
            </a>
          ),
          table: ({ children }) => <table className="md-table">{children}</table>,
          input: ({ checked, ...props }) => (
            <input type="checkbox" checked={checked} disabled readOnly className="md-checkbox" {...props} />
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
