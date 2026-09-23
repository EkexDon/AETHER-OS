import { Keyboard, Moon, Sun } from "lucide-react";
import { useThemeStore } from "../lib/theme";
import { Kbd, Tooltip } from "../ui";
import { useShellStore } from "./shellStore";
import { useStatusItems, type StatusItem } from "./statusbar/registry";
import { ShellErrorBoundary } from "./ErrorBoundary";

function Items({ items }: { items: StatusItem[] }) {
  return (
    <>
      {items.map((item) => {
        const C = item.component;
        return (
          <ShellErrorBoundary key={item.id} fallback={null} label={item.id}>
            <C />
          </ShellErrorBoundary>
        );
      })}
    </>
  );
}

/**
 * Bottom status bar: registered items on the left and right, then the
 * command palette hint, the shortcuts overlay and the theme toggle.
 */
export function StatusBar() {
  const left = useStatusItems("left");
  const right = useStatusItems("right");
  const resolved = useThemeStore((s) => s.resolved);
  const toggleTheme = useThemeStore((s) => s.toggle);
  const toggleCommandBar = useShellStore((s) => s.toggleCommandBar);
  const toggleShortcuts = useShellStore((s) => s.toggleShortcuts);

  return (
    <footer className="statusbar">
      <div className="statusbar-section">
        <Items items={left} />
      </div>
      <div className="statusbar-spacer" />
      <div className="statusbar-section">
        <Items items={right} />
        <Tooltip content="Command palette" placement="top">
          <button type="button" className="statusbar-item" onClick={toggleCommandBar}>
            <span className="statusbar-muted">Commands</span>
            <Kbd shortcut="mod+k" />
          </button>
        </Tooltip>
        <Tooltip content="Keyboard shortcuts" shortcut="mod+/" placement="top">
          <button type="button" className="statusbar-item statusbar-icon" onClick={toggleShortcuts} aria-label="Keyboard shortcuts">
            <Keyboard size={13} />
          </button>
        </Tooltip>
        <Tooltip
          content={resolved === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          shortcut="mod+shift+l"
          placement="top"
        >
          <button
            type="button"
            className="statusbar-item statusbar-icon"
            onClick={toggleTheme}
            aria-label={resolved === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          >
            {resolved === "dark" ? <Moon size={13} /> : <Sun size={13} />}
          </button>
        </Tooltip>
      </div>
    </footer>
  );
}
