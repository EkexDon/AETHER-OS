import { Bot, Scissors, Search, Zap } from "lucide-react";
import { useAetherStore } from "../lib/store";
import { getView } from "../views/registry";
import { IconButton, Kbd } from "../ui";
import { useShellStore } from "./shellStore";
import { BrandMark } from "./BrandMark";

/**
 * The 38px window strip. macOS draws the traffic lights over its left edge;
 * every non-interactive part carries `data-tauri-drag-region` so the window
 * can be dragged (and double-click maximises). The centre holds the command
 * palette trigger, the right side the capture actions and the agent toggle.
 */
export function Titlebar() {
  const view = useAetherStore((s) => s.view);
  const chatOpen = useAetherStore((s) => s.chatOpen);
  const setChatOpen = useAetherStore((s) => s.setChatOpen);
  const setShowQuickCapture = useAetherStore((s) => s.setShowQuickCapture);
  const toggleCommandBar = useShellStore((s) => s.toggleCommandBar);
  const setWebClipperOpen = useShellStore((s) => s.setWebClipperOpen);
  const current = getView(view);

  return (
    <header className="titlebar" data-tauri-drag-region>
      <div className="titlebar-left" data-tauri-drag-region>
        <span className="titlebar-brand" data-tauri-drag-region>
          <BrandMark size={15} />
          <span className="titlebar-brand-name">AETHER</span>
        </span>
        {current && (
          <>
            <span className="titlebar-sep" aria-hidden="true">/</span>
            <span className="titlebar-view" data-tauri-drag-region>
              {current.label}
            </span>
          </>
        )}
      </div>

      <button type="button" className="titlebar-command" onClick={toggleCommandBar} aria-label="Open command palette">
        <Search size={13} />
        <span className="titlebar-command-text">Search notes, files, apps and commands</span>
        <Kbd shortcut="mod+k" />
      </button>

      <div className="titlebar-right" data-tauri-drag-region>
        <IconButton
          label="Quick capture"
          shortcut="mod+shift+n"
          size="sm"
          icon={<Zap size={14} />}
          tooltipPlacement="bottom"
          onClick={() => setShowQuickCapture(true)}
        />
        <IconButton
          label="Clip a web page"
          shortcut="mod+shift+c"
          size="sm"
          icon={<Scissors size={14} />}
          tooltipPlacement="bottom"
          onClick={() => setWebClipperOpen(true)}
        />
        <span className="titlebar-divider" aria-hidden="true" />
        <IconButton
          label={chatOpen ? "Hide AI agent" : "Show AI agent"}
          shortcut="mod+j"
          size="sm"
          active={chatOpen}
          icon={<Bot size={15} />}
          tooltipPlacement="bottom"
          onClick={() => setChatOpen(!chatOpen)}
        />
      </div>
    </header>
  );
}
