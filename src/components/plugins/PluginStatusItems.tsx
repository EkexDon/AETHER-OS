import { Blocks } from "lucide-react";
import { useAetherStore } from "../../lib/store";
import { usePluginsStore } from "../../lib/pluginsStore";
import { Tooltip } from "../../ui";

/**
 * Status bar texts contributed by running plugins; clicking an item opens
 * that plugin's panel. (The plugin host itself is started at launch by
 * `PluginHostBootstrap` in the shell's feature hosts.)
 */
export function PluginStatusItems() {
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
              <Blocks size={14} aria-hidden="true" />
              <span className="statusbar-muted tabular">{item.text}</span>
            </button>
          </Tooltip>
        );
      })}
    </>
  );
}
