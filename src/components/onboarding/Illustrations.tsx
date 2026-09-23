import type { ReactNode } from "react";
import {
  Bot,
  CalendarDays,
  Check,
  CodeXml,
  FileText,
  FolderClosed,
  HardDrive,
  Lock,
  NotebookPen,
  Search,
  Sparkles,
  SquareTerminal,
  Waypoints,
} from "lucide-react";
import type { WizardStepId } from "../../lib/onboarding/wizard";

/**
 * Step illustrations composed from tokens and icons only (no images), so
 * they follow the theme, the accent and the density. Purely decorative.
 */

function Frame({ children, variant }: { children: ReactNode; variant: string }) {
  return (
    <div className={`ob-illus ob-illus-${variant}`} aria-hidden="true">
      {children}
    </div>
  );
}

function Lines({ widths }: { widths: number[] }) {
  return (
    <>
      {widths.map((w, i) => (
        <span key={i} className="ob-illus-line" style={{ width: `${w}%` }} />
      ))}
    </>
  );
}

/** A miniature app window: rail, note, agent bubble. */
function WelcomeIllustration() {
  return (
    <Frame variant="welcome">
      <div className="ob-mini-window">
        <div className="ob-mini-titlebar">
          <span />
          <span />
          <span />
          <span className="ob-mini-pill">⌘K</span>
        </div>
        <div className="ob-mini-body">
          <div className="ob-mini-rail">
            <NotebookPen size={12} />
            <Waypoints size={12} />
            <CodeXml size={12} />
            <CalendarDays size={12} />
          </div>
          <div className="ob-mini-note">
            <span className="ob-illus-heading" />
            <Lines widths={[92, 78, 86, 54]} />
            <span className="ob-mini-link">[[Project idea]]</span>
          </div>
          <div className="ob-mini-agent">
            <span className="ob-mini-bubble is-user" />
            <span className="ob-mini-bubble">
              <Sparkles size={11} />
            </span>
          </div>
        </div>
      </div>
    </Frame>
  );
}

/** A folder tree turning into linked notes. */
function VaultIllustration() {
  const rows: { icon: ReactNode; label: string; depth: number; accent?: boolean }[] = [
    { icon: <FolderClosed size={12} />, label: "AETHER Vault", depth: 0 },
    { icon: <FileText size={12} />, label: "Welcome.md", depth: 1, accent: true },
    { icon: <FolderClosed size={12} />, label: "daily", depth: 1 },
    { icon: <FolderClosed size={12} />, label: "Projects", depth: 1 },
    { icon: <FolderClosed size={12} />, label: "Resources", depth: 1 },
  ];
  return (
    <Frame variant="vault">
      <div className="ob-tree">
        {rows.map((r) => (
          <div key={r.label} className={r.accent ? "ob-tree-row is-accent" : "ob-tree-row"} style={{ paddingLeft: 10 + r.depth * 16 }}>
            {r.icon}
            <span>{r.label}</span>
          </div>
        ))}
      </div>
      <div className="ob-graph">
        <span className="ob-graph-node is-main" />
        <span className="ob-graph-node n1" />
        <span className="ob-graph-node n2" />
        <span className="ob-graph-node n3" />
        <span className="ob-graph-edge e1" />
        <span className="ob-graph-edge e2" />
        <span className="ob-graph-edge e3" />
      </div>
    </Frame>
  );
}

/** This machine ↔ Ollama on localhost; the lock marks "stays local". */
function AiIllustration() {
  return (
    <Frame variant="ai">
      <div className="ob-node-card">
        <HardDrive size={16} />
        <span className="ob-node-title">This Mac</span>
        <span className="ob-node-meta">your notes</span>
      </div>
      <div className="ob-link-line">
        <span className="ob-link-badge">
          <Lock size={11} /> localhost:11434
        </span>
      </div>
      <div className="ob-node-card is-accent">
        <Bot size={16} />
        <span className="ob-node-title">Ollama</span>
        <span className="ob-node-meta">local model</span>
      </div>
    </Frame>
  );
}

/** A query pill pulling related notes out of a cloud of dots. */
function EmbeddingsIllustration() {
  const dots = [
    [12, 22, 1],
    [22, 64, 2],
    [34, 30, 3],
    [46, 72, 1],
    [58, 18, 4],
    [66, 56, 2],
    [78, 34, 5],
    [86, 70, 3],
    [40, 50, 6],
    [72, 82, 4],
  ];
  return (
    <Frame variant="embeddings">
      <div className="ob-cloud">
        {dots.map(([x, y, c], i) => (
          <span
            key={i}
            className={i === 2 || i === 8 || i === 5 ? "ob-cloud-dot is-hit" : "ob-cloud-dot"}
            style={{ left: `${x}%`, top: `${y}%`, background: `var(--color-cat-${c})` }}
          />
        ))}
      </div>
      <div className="ob-query-pill">
        <Search size={12} /> ideas about sleep
      </div>
    </Frame>
  );
}

/** Oversized key caps. */
function TourIllustration() {
  return (
    <Frame variant="tour">
      <span className="ob-keycap">⌘</span>
      <span className="ob-keycap">K</span>
      <div className="ob-tour-icons">
        <SquareTerminal size={14} />
        <Bot size={14} />
        <CalendarDays size={14} />
      </div>
    </Frame>
  );
}

/** A calm confirmation mark. */
function DoneIllustration() {
  return (
    <Frame variant="done">
      <span className="ob-done-ring">
        <Check size={28} strokeWidth={2.4} />
      </span>
    </Frame>
  );
}

/** The illustration for a wizard step. */
export function StepIllustration({ step }: { step: WizardStepId }) {
  switch (step) {
    case "welcome":
      return <WelcomeIllustration />;
    case "vault":
      return <VaultIllustration />;
    case "ai":
      return <AiIllustration />;
    case "embeddings":
      return <EmbeddingsIllustration />;
    case "tour":
      return <TourIllustration />;
    case "done":
      return <DoneIllustration />;
  }
}
