import React, { useEffect, useRef } from "react";
import { useAetherStore } from "../lib/store";

export function VaultGraph() {
  const { graph } = useAetherStore();
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    ctx.fillStyle = "#0a0a0c";
    ctx.fillRect(0, 0, w, h);

    if (graph.nodes.length === 0) {
      ctx.fillStyle = "#444";
      ctx.font = "14px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("No graph data — open a vault to see connections", w / 2, h / 2);
      return;
    }

    const positions = new Map<string, { x: number; y: number }>();
    graph.nodes.forEach((node, i) => {
      const angle = (i / graph.nodes.length) * Math.PI * 2;
      const radius = Math.min(w, h) * 0.35;
      positions.set(node.id, {
        x: w / 2 + Math.cos(angle) * radius,
        y: h / 2 + Math.sin(angle) * radius,
      });
    });

    ctx.strokeStyle = "#1a1a2e";
    ctx.lineWidth = 1;
    graph.edges.forEach((edge) => {
      const s = positions.get(edge.source);
      const t = positions.get(edge.target);
      if (!s || !t) return;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(t.x, t.y);
      ctx.stroke();
    });

    graph.nodes.forEach((node) => {
      const pos = positions.get(node.id);
      if (!pos) return;
      ctx.fillStyle = "#2a2a4e";
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#666";
      ctx.font = "10px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(node.label, pos.x, pos.y - 8);
    });
  }, [graph]);

  return (
    <div className="vault-graph">
      <canvas
        ref={canvasRef}
        width={800}
        height={600}
        className="graph-canvas"
      />
    </div>
  );
}
