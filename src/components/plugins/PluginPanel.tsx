import { Component, useMemo, type ErrorInfo, type ReactNode } from "react";
import { TriangleAlert } from "lucide-react";
import { Badge, Button, cx } from "../../ui";
import { MarkdownRenderer } from "../MarkdownRenderer";
import { groupBadges, sanitizePluginMarkdown, sanitizeViewTree, type PluginViewNode } from "../../lib/plugins/viewTree";

/** Props of {@link PluginPanel}. */
export interface PluginPanelProps {
  /** Validated nodes (from `sanitizeViewTree`). */
  nodes: PluginViewNode[];
  /** A button with `actionId` was clicked. */
  onAction: (actionId: string) => void;
  /** Accessible name of the panel region. */
  label: string;
  /** Called when the panel cannot be rendered (invalid tree or a render error). */
  onError?: (message: string) => void;
}

type Grouped = ReturnType<typeof groupBadges>[number];

function PanelNode({ node, onAction }: { node: Grouped; onAction: (actionId: string) => void }) {
  switch (node.type) {
    case "text":
      return <p className={cx("plugin-panel-text", node.tone === "muted" && "is-muted")}>{node.text}</p>;
    case "heading": {
      const Tag = node.level === 1 ? "h3" : node.level === 2 ? "h4" : "h5";
      return <Tag className={`plugin-panel-heading is-level-${node.level}`}>{node.text}</Tag>;
    }
    case "list": {
      const List = node.ordered ? "ol" : "ul";
      return (
        <List className={cx("plugin-panel-list", node.ordered && "is-ordered")}>
          {node.items.map((item, i) => (
            <li key={i} className="plugin-panel-list-item" data-indent={item.indent}>
              <span className="plugin-panel-list-text">{item.text}</span>
              {item.meta && <span className="plugin-panel-list-meta tabular">{item.meta}</span>}
            </li>
          ))}
        </List>
      );
    }
    case "button":
      return (
        <div className="plugin-panel-action">
          <Button size="sm" variant={node.variant} onClick={() => onAction(node.actionId)}>
            {node.label}
          </Button>
        </div>
      );
    case "badges":
      return (
        <div className="plugin-panel-badges">
          {node.badges.map((badge, i) => (
            <Badge key={i} variant={badge.variant}>
              {badge.text}
            </Badge>
          ))}
        </div>
      );
    case "badge":
      return <Badge variant={node.variant}>{node.text}</Badge>;
    case "divider":
      return <hr className="plugin-panel-divider" />;
    case "markdown":
      return (
        <div className="plugin-panel-markdown">
          <MarkdownRenderer content={sanitizePluginMarkdown(node.content)} allowMedia={false} />
        </div>
      );
    default:
      return null;
  }
}

function PanelProblem({ message }: { message: string }) {
  return (
    <div className="ui-notice ui-notice-danger plugin-panel-problem" role="alert">
      <TriangleAlert size={14} aria-hidden="true" />
      <span>This panel could not be displayed: {message}</span>
    </div>
  );
}

interface BoundaryProps {
  children: ReactNode;
  onError?: (message: string) => void;
  /** A new value (the plugin sent a new tree) clears a previous error. */
  resetKey: unknown;
}

/** Keeps a crashing panel from taking the Plugins page down with it. */
class PanelBoundary extends Component<BoundaryProps, { message: string | null }> {
  state = { message: null as string | null };

  static getDerivedStateFromError(error: unknown) {
    return { message: error instanceof Error ? error.message : String(error) };
  }

  componentDidCatch(error: Error, _info: ErrorInfo): void {
    this.props.onError?.(error.message);
  }

  componentDidUpdate(prev: BoundaryProps): void {
    if (prev.resetKey !== this.props.resetKey && this.state.message !== null) this.setState({ message: null });
  }

  render() {
    return this.state.message !== null ? <PanelProblem message={this.state.message} /> : this.props.children;
  }
}

/**
 * Renders a plugin's declarative panel. The tree is validated again here
 * (only known node types with string props render, whatever reached the
 * store); every string is rendered as a React text node (never as HTML);
 * Markdown goes through the sanitiser and the app's renderer, which shows
 * raw HTML as text and loads no media. Render errors stay inside the panel.
 */
export function PluginPanel({ nodes, onAction, label, onError }: PluginPanelProps) {
  const checked = useMemo((): { nodes: PluginViewNode[]; error: null } | { nodes: null; error: string } => {
    try {
      return { nodes: sanitizeViewTree(nodes), error: null };
    } catch (error) {
      return { nodes: null, error: error instanceof Error ? error.message : String(error) };
    }
  }, [nodes]);

  return (
    <section className="plugin-panel" aria-label={label}>
      {checked.error !== null ? (
        <PanelProblem message={checked.error} />
      ) : (
        <PanelBoundary key={label} onError={onError} resetKey={nodes}>
          {groupBadges(checked.nodes).map((node, i) => (
            <PanelNode key={i} node={node} onAction={onAction} />
          ))}
        </PanelBoundary>
      )}
    </section>
  );
}
