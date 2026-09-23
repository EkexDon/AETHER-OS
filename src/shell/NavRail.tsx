import { PanelLeftClose, PanelLeftOpen, Settings } from "lucide-react";
import type { ReactNode } from "react";
import { useAetherStore } from "../lib/store";
import { useAppearanceStore } from "../lib/appearance";
import { formatShortcut } from "../lib/shortcuts";
import { VIEW_GROUPS } from "../views/modes";
import { viewsByGroup, VIEWS, type ViewDefinition } from "../views/registry";
import { Tooltip, cx } from "../ui";
import { useShellStore } from "./shellStore";

interface RailButtonProps {
  icon: ReactNode;
  label: string;
  shortcut?: string;
  active?: boolean;
  expanded: boolean;
  onClick: () => void;
  current?: boolean;
}

function RailButton({ icon, label, shortcut, active, expanded, onClick, current }: RailButtonProps) {
  return (
    <Tooltip content={label} shortcut={shortcut} placement="right" disabled={expanded} delay={250} describeChild={false}>
      <button
        type="button"
        className={cx("nav-item", active && "is-active")}
        aria-current={current ? "page" : undefined}
        aria-label={label}
        onClick={onClick}
      >
        <span className="nav-item-icon">{icon}</span>
        <span className="nav-item-label">{label}</span>
        {shortcut && <span className="nav-item-shortcut">{formatShortcut(shortcut)}</span>}
      </button>
    </Tooltip>
  );
}

/**
 * Left navigation rail: every workspace grouped (Knowledge · Build · Life ·
 * System), tooltips with shortcuts when collapsed, labels when expanded.
 */
export function NavRail() {
  const view = useAetherStore((s) => s.view);
  const setView = useAetherStore((s) => s.setView);
  const expanded = useAppearanceStore((s) => s.railExpanded);
  const toggleExpanded = useAppearanceStore((s) => s.toggleRailExpanded);
  const openSettings = useShellStore((s) => s.openSettings);
  const settingsOpen = useShellStore((s) => s.settingsOpen);
  const groups = viewsByGroup(VIEWS);

  const renderItem = (v: ViewDefinition) => {
    const Icon = v.icon;
    const active = view === v.mode;
    return (
      <RailButton
        key={v.mode}
        icon={<Icon size={18} strokeWidth={active ? 2 : 1.75} />}
        label={v.label}
        shortcut={v.shortcut}
        active={active}
        current={active}
        expanded={expanded}
        onClick={() => setView(v.mode)}
      />
    );
  };

  return (
    <nav className={cx("nav-rail", expanded && "is-expanded")} aria-label="Workspaces">
      <div className="nav-rail-scroll">
        {VIEW_GROUPS.map((g, i) => {
          const views = groups.get(g.id);
          if (!views || views.length === 0) return null;
          return (
            <div key={g.id} className="nav-group" role="group" aria-label={g.label}>
              {expanded ? (
                <div className="nav-group-label">{g.label}</div>
              ) : (
                i > 0 && <div className="nav-group-sep" aria-hidden="true" />
              )}
              {views.map(renderItem)}
            </div>
          );
        })}
      </div>
      <div className="nav-rail-footer">
        <RailButton
          icon={<Settings size={18} strokeWidth={1.75} />}
          label="Settings"
          shortcut="mod+,"
          active={settingsOpen}
          expanded={expanded}
          onClick={() => openSettings()}
        />
        <RailButton
          icon={expanded ? <PanelLeftClose size={18} strokeWidth={1.75} /> : <PanelLeftOpen size={18} strokeWidth={1.75} />}
          label={expanded ? "Hide labels" : "Show labels"}
          shortcut="mod+\\"
          expanded={expanded}
          onClick={toggleExpanded}
        />
      </div>
    </nav>
  );
}
