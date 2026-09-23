import { Blocks } from "lucide-react";
import "../../styles/views/plugins.css";
import { useAetherStore } from "../../lib/store";
import { usePluginsStore } from "../../lib/pluginsStore";
import { usePluginHostBootstrap } from "../../lib/plugins/useBootstrap";
import { Tooltip } from "../../ui";

/**
 * Status bar texts contributed by running plugins. Always mounted (it is a
 * registered status bar item), which is also what starts the plugin host at
 * app launch. Clicking an item opens that plugin's panel.
 */
export function PluginStatusItems() {
  usePluginHostBootstrap();
  const items = usePluginsStore((s) => s.statusItems);
  const plugins = usePluginsStore((s) => s.plugins);
  const setActivePanel = usePluginsStore((s) => s.setActivePanel);
  const setView = useAetherStore((s) => s.setView);

  const entries = plugins.filter((p) => items[p.manifest.id]);
  if (entries.length === 0) return null;

  return (
    <>
      {entries.map((plugin) => {
        const id = plugin.manifest.id;
        const item = items[id];
        const tooltip = `${item.tooltip ?? item.text} — ${plugin.manifest.name} plugin`;
        return (
          <Tooltip key={id} content={tooltip} placement="top">
            <button
              type="button"
              className="statusbar-item plugin-status-item"
              onClick={() => {
                setActivePanel(id);
                setView("plugins");
              }}
            >
              <Blocks size={12} aria-hidden="true" />
              <span className="statusbar-muted tabular">{item.text}</span>
            </button>
          </Tooltip>
        );
      })}
    </>
  );
}
