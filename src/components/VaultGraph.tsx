import { useRef, useEffect, useState, useMemo, useCallback } from "react";
import ForceGraph2D from "react-force-graph-2d";
import { useAetherStore } from "../lib/store";
import { getVaultGraph, getNoteContent, createNote, getVaultNotes } from "../lib/ipc";

const COLORS = ["#a78bfa", "#60a5fa", "#34d399", "#fbbf24", "#f87171", "#f472b6", "#38bdf8", "#818cf8"];

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
  }, []);

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
      void getNoteContent(node.id)
        .then((content) => setNoteContent(content))
        .catch(() => setNoteContent(null));
    },
    [selectNote, setView, setNoteContent]
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
      let color = "#a78bfa";
      if (node.tags && node.tags.length > 0) {
        let hash = 0;
        for (let i = 0; i < node.tags[0].length; i++)
          hash = node.tags[0].charCodeAt(i) + ((hash << 5) - hash);
        color = COLORS[Math.abs(hash) % COLORS.length];
      }

      const isMuted = activeTag && !(node.tags || []).includes(activeTag);
      ctx.globalAlpha = isMuted ? 0.15 : 1.0;

      // Node circle with white rim
      ctx.beginPath();
      ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = "rgba(255, 255, 255, 0.4)";
      ctx.lineWidth = 1;
      ctx.stroke();

      // Label
      if (globalScale >= 0.8 && !isMuted) {
        const label = node.label as string;
        const fontSize = 11 / globalScale;
        ctx.font = `${fontSize}px -apple-system, BlinkMacSystemFont, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.globalAlpha = 0.85;
        ctx.fillStyle = "#e4e4e8";
        ctx.fillText(label, node.x, node.y + r + 3);
      }
      ctx.globalAlpha = 1.0;
    },
    [activeTag]
  );

  // Link color based on tag filter
  const linkColor = useCallback(
    (link: any) => {
      if (!activeTag) return "rgba(107, 107, 245, 0.25)";
      const sHas = (link.source?.tags || []).includes(activeTag);
      const tHas = (link.target?.tags || []).includes(activeTag);
      return sHas || tHas ? "rgba(107, 107, 245, 0.25)" : "rgba(107, 107, 245, 0.05)";
    },
    [activeTag]
  );

  if (graph.nodes.length === 0) {
    return (
      <div className="vault-graph-empty">
        <div className="vault-graph-empty-inner">
          <p>No graph data — open a vault to see connections</p>
        </div>
      </div>
    );
  }

  return (
    <div className="graph-shell">
      <div className="graph-topbar">
        <div className="graph-topbar-row">
          <span className="graph-stats">
            Knowledge Graph — {filteredData.nodes.length} notes,{" "}
            {filteredData.links.length} connections
            {activeTag ? ` (filtered by #${activeTag})` : ""}
          </span>
          <span className="graph-hint">Double-click empty space to create note</span>
        </div>
        {allTags.length > 0 && (
          <div className="graph-tag-pills">
            <button
              className={`graph-tag-pill ${!activeTag ? "active" : ""}`}
              onClick={() => setActiveTag(null)}
            >
              All
            </button>
            {allTags.map((tag) => (
              <button
                key={tag}
                className={`graph-tag-pill ${activeTag === tag ? "active" : ""}`}
                onClick={() => setActiveTag(tag)}
              >
                #{tag}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="graph-canvas" ref={containerRef}>
        <ForceGraph2D
          ref={fgRef}
          graphData={filteredData as any}
          nodeCanvasObject={nodeCanvasObject}
          nodeLabel="label"
          linkColor={linkColor as any}
          linkWidth={1.5}
          linkDirectionalParticleWidth={4}
          linkDirectionalParticleSpeed={0.02}
          linkDirectionalParticleColor={() => "rgba(107, 107, 245, 0.9)"}
          backgroundColor="#0a0a0c"
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
