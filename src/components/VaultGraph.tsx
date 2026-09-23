import { useRef, useEffect, useState, useMemo, useCallback } from "react";
import ForceGraph2D from "react-force-graph-2d";
import { useAetherStore } from "../lib/store";
import { getVaultGraph, getNoteContent, createNote, getVaultNotes } from "../lib/ipc";
import { Waypoints } from "lucide-react";
import { useTokens, withAlpha } from "../lib/tokens";
import { EmptyState, ViewHeader, cx } from "../ui";

/** Canvas colours come from the design tokens so the graph follows the theme. */
const GRAPH_TOKENS = [
  "--color-bg",
  "--color-fg-secondary",
  "--color-fg-tertiary",
  "--color-border-strong",
  "--color-accent",
  "--color-cat-1",
  "--color-cat-2",
  "--color-cat-3",
  "--color-cat-4",
  "--color-cat-5",
  "--color-cat-6",
  "--color-cat-7",
  "--color-cat-8",
] as const;

function endpointId(v: string | { id: string }): string {
  return typeof v === "object" && v !== null ? v.id : v;
}

export function VaultGraph() {
  const { graph, setGraph, selectNote, setNoteContent, setView, setVaultNotes } = useAetherStore();

  const fgRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });
  const clickTimeout = useRef<number>(0);
  const isMounted = useRef(true);
  const tokens = useTokens(GRAPH_TOKENS);
  const palette = useMemo(
    () => [
      tokens["--color-cat-1"],
      tokens["--color-cat-2"],
      tokens["--color-cat-3"],
      tokens["--color-cat-4"],
      tokens["--color-cat-5"],
      tokens["--color-cat-6"],
      tokens["--color-cat-7"],
      tokens["--color-cat-8"],
    ],
    [tokens]
  );

  // Re-fetch graph data on mount
  useEffect(() => {
    isMounted.current = true;
    void getVaultGraph()
      .then((data) => {
        if (isMounted.current) setGraph(data);
      })
      .catch(() => {});
    return () => {
      isMounted.current = false;
    };
  }, [setGraph]);

  // ResizeObserver for responsive canvas
  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const newW = Math.floor(entry.contentRect.width);
        const newH = Math.floor(entry.contentRect.height);
        setDimensions((prev) =>
          prev.width === newW && prev.height === newH ? prev : { width: newW, height: newH }
        );
      }
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
    // Re-attach when the canvas mounts after the graph data arrives.
  }, [graph.nodes.length === 0]);

  // Collect all tags from graph nodes
  const allTags = useMemo(() => {
    const tags = new Set<string>();
    graph.nodes.forEach((n) => (n.tags || []).forEach((t) => tags.add(t)));
    return Array.from(tags).sort();
  }, [graph.nodes]);

  // Convert GraphData (nodes/edges) to force-graph format (nodes/links)
  const fgData = useMemo(() => {
    return {
      nodes: graph.nodes.map((n) => ({ id: n.id, label: n.label, tags: n.tags || [] })),
      links: graph.edges.map((e) => ({ source: e.source, target: e.target })),
    };
  }, [graph]);

  // Filtered data for tag filtering
  const filteredData = useMemo(() => {
    if (!activeTag) return fgData;
    const nodes = fgData.nodes.filter((n: any) => (n.tags || []).includes(activeTag));
    const nodeIds = new Set(nodes.map((n: any) => n.id));
    const links = fgData.links.filter(
      (l: any) => nodeIds.has(endpointId(l.source)) && nodeIds.has(endpointId(l.target))
    );
    return { nodes, links };
  }, [fgData, activeTag]);

  // Configure D3 force parameters
  useEffect(() => {
    if (!fgRef.current) return;
    const fg = fgRef.current;
    if (typeof fg.d3Force !== "function") return;

    const charge = fg.d3Force("charge");
    if (charge) charge.strength(-200);
    const link = fg.d3Force("link");
    if (link) link.distance(100);
    const center = fg.d3Force("center");
    if (center) center.strength(0.05);
  }, [fgData]);

  // Node click → open note in editor
  const onNodeClick = useCallback(
    (node: any) => {
      selectNote(node.id);
      setView("editor");
    },
    [selectNote, setView]
  );

  // Double-click background → create new note
  const handleBackgroundClick = useCallback(() => {
    const now = Date.now();
    if (now - clickTimeout.current < 300) {
      const id = Math.random().toString(36).substring(2, 6).toUpperCase();
      const name = `Untitled-${id}`;
      void createNote(name, `# ${name}\n\n`)
        .then((path) => {
          void getVaultNotes().then(setVaultNotes);
          selectNote(path);
          setNoteContent(`# ${name}\n\n`);
          setView("editor");
        })
        .catch(() => {});
      clickTimeout.current = 0;
    } else {
      clickTimeout.current = now;
    }
  }, [selectNote, setNoteContent, setView, setVaultNotes]);

  // Custom canvas node rendering
  const nodeCanvasObject = useCallback(
    (node: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const r = 5;

      // Color based on first tag hash
      let color = tokens["--color-fg-tertiary"];
      if (node.tags && node.tags.length > 0) {
        let hash = 0;
        for (let i = 0; i < node.tags[0].length; i++)
          hash = node.tags[0].charCodeAt(i) + ((hash << 5) - hash);
        color = palette[Math.abs(hash) % palette.length];
      }

      const isMuted = activeTag && !(node.tags || []).includes(activeTag);
      ctx.globalAlpha = isMuted ? 0.15 : 1.0;

      // Node circle with white rim
      ctx.beginPath();
      ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = tokens["--color-bg"];
      ctx.lineWidth = 1.5 / Math.max(globalScale, 0.5);
      ctx.stroke();

      // Label
      if (globalScale >= 0.8 && !isMuted) {
        const label = node.label as string;
        const fontSize = 11 / globalScale;
        ctx.font = `500 ${fontSize}px "IBM Plex Sans Variable", -apple-system, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.globalAlpha = 0.85;
        ctx.fillStyle = tokens["--color-fg-secondary"];
        ctx.fillText(label, node.x, node.y + r + 3);
      }
      ctx.globalAlpha = 1.0;
    },
    [activeTag, tokens, palette]
  );

  // Link color based on tag filter
  const linkColor = useCallback(
    (link: any) => {
      const base = tokens["--color-border-strong"];
      if (!activeTag) return base;
      const sHas = (link.source?.tags || []).includes(activeTag);
      const tHas = (link.target?.tags || []).includes(activeTag);
      return sHas || tHas ? withAlpha(tokens["--color-accent"], 0.45) : withAlpha(tokens["--color-fg-tertiary"], 0.08);
    },
    [activeTag, tokens]
  );

  if (graph.nodes.length === 0) {
    return (
      <div className="view graph-shell">
        <ViewHeader title="Knowledge Graph" subtitle="Every wikilink in your vault, as a map" />
        <div className="view-body vault-graph-empty">
          <EmptyState
            icon={Waypoints}
            title="No graph data"
            description="Open a vault to see how your notes connect through wikilinks."
          />
        </div>
      </div>
    );
  }

  return (
    <div className="view graph-shell">
      <ViewHeader
        compact
        bordered
        icon={Waypoints}
        title="Knowledge Graph"
        subtitle={
          <span className="graph-stats">
            {filteredData.nodes.length} notes, {filteredData.links.length} connections
            {activeTag ? ` (filtered by #${activeTag})` : ""}
          </span>
        }
        actions={<span className="graph-hint">Double-click empty space to create note</span>}
        tabs={
          allTags.length > 0 ? (
            <div className="graph-tag-pills" role="toolbar" aria-label="Filter by tag">
              <button
                type="button"
                className={cx("graph-tag-pill", !activeTag && "active")}
                aria-pressed={!activeTag}
                onClick={() => setActiveTag(null)}
              >
                All
              </button>
              {allTags.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  className={cx("graph-tag-pill", activeTag === tag && "active")}
                  aria-pressed={activeTag === tag}
                  onClick={() => setActiveTag(tag)}
                >
                  #{tag}
                </button>
              ))}
            </div>
          ) : undefined
        }
      />
      <div className="graph-canvas" ref={containerRef}>
        <ForceGraph2D
          ref={fgRef}
          graphData={filteredData as any}
          nodeCanvasObject={nodeCanvasObject}
          nodeLabel="label"
          linkColor={linkColor as any}
          linkWidth={1}
          linkDirectionalParticleWidth={3}
          linkDirectionalParticleSpeed={0.02}
          linkDirectionalParticleColor={() => tokens["--color-accent"]}
          backgroundColor={tokens["--color-bg"]}
          onNodeClick={onNodeClick}
          onBackgroundClick={handleBackgroundClick}
          enableNodeDrag
          enablePanInteraction
          enableZoomInteraction
          width={dimensions.width}
          height={dimensions.height}
        />
      </div>
    </div>
  );
}
