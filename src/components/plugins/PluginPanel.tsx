import { Badge, Button, cx } from "../../ui";
import { MarkdownRenderer } from "../MarkdownRenderer";
import { groupBadges, sanitizePluginMarkdown, type PluginViewNode } from "../../lib/plugins/viewTree";

/** Props of {@link PluginPanel}. */
export interface PluginPanelProps {
  /** Validated nodes (from `sanitizeViewTree`). */
  nodes: PluginViewNode[];
  /** A button with `actionId` was clicked. */
  onAction: (actionId: string) => void;
  /** Accessible name of the panel region. */
  label: string;
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
          <MarkdownRenderer content={sanitizePluginMarkdown(node.content)} />
        </div>
      );
  }
}

/**
 * Renders a plugin's declarative panel. Every string is rendered as a React
 * text node (never as HTML); Markdown goes through the sanitiser and the
 * app's renderer, which shows raw HTML as text.
 */
export function PluginPanel({ nodes, onAction, label }: PluginPanelProps) {
  return (
    <section className="plugin-panel" aria-label={label}>
      {groupBadges(nodes).map((node, i) => (
        <PanelNode key={i} node={node} onAction={onAction} />
      ))}
    </section>
  );
}
