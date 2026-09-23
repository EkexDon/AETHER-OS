import { useMemo } from "react";
import { Blocks, FolderOpen, PanelRight, Plus, RotateCw } from "lucide-react";
import { isDesktopRuntime, openPluginsFolder } from "../../lib/ipc";
import { usePluginsStore } from "../../lib/pluginsStore";
import { getPluginHost } from "../../lib/plugins/host";
import { usePluginHostBootstrap } from "../../lib/plugins/useBootstrap";
import { Button, Card, EmptyState, Spinner, Tabs, ViewHeader, useToast } from "../../ui";
import { InstallPluginModal } from "./InstallPluginModal";
import { PermissionsModal } from "./PermissionsModal";
import { PluginCard } from "./PluginCard";
import { PluginPanel } from "./PluginPanel";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Panels of running plugins, one tab each. */
function PanelsArea() {
  const plugins = usePluginsStore((s) => s.plugins);
  const panels = usePluginsStore((s) => s.panels);
  const activePanelId = usePluginsStore((s) => s.activePanelId);
  const setActivePanel = usePluginsStore((s) => s.setActivePanel);
  const addLog = usePluginsStore((s) => s.addLog);

  const withPanels = useMemo(() => plugins.filter((p) => panels[p.manifest.id]), [plugins, panels]);
  const active = withPanels.find((p) => p.manifest.id === activePanelId) ?? withPanels[0];

  return (
    <Card padding="none" className="plugins-panels">
      <div className="plugins-panels-head">
        <span className="ui-section-label">Plugin panels</span>
        {withPanels.length > 1 && (
          <Tabs
            variant="pill"
            size="sm"
            aria-label="Plugin panels"
            idPrefix="plugin-panel"
            value={active?.manifest.id ?? ""}
            onChange={setActivePanel}
            items={withPanels.map((p) => ({ id: p.manifest.id, label: p.manifest.name }))}
          />
        )}
      </div>
      {active ? (
        <div
          className="plugins-panels-body"
          role={withPanels.length > 1 ? "tabpanel" : undefined}
          id={withPanels.length > 1 ? `plugin-panel-panel-${active.manifest.id}` : undefined}
        >
          <PluginPanel
            label={`${active.manifest.name} panel`}
            nodes={panels[active.manifest.id]}
            onAction={(actionId) => getPluginHost().sendPanelAction(active.manifest.id, actionId)}
            onError={(problem) => addLog(active.manifest.id, "error", `Panel could not be displayed: ${problem}`)}
          />
        </div>
      ) : (
        <EmptyState
          size="sm"
          icon={PanelRight}
          title="No plugin panels"
          description="Enable a plugin with the panel permission, such as Word Count, and its panel appears here."
        />
      )}
    </Card>
  );
}

/** The plugin manager (view mode `plugins`). */
export function PluginsView() {
  usePluginHostBootstrap();
  const plugins = usePluginsStore((s) => s.plugins);
  const loaded = usePluginsStore((s) => s.loaded);
  const loadError = usePluginsStore((s) => s.loadError);
  const runtime = usePluginsStore((s) => s.runtime);
  const refresh = usePluginsStore((s) => s.refresh);
  const setInstallOpen = usePluginsStore((s) => s.setInstallOpen);
  const toast = useToast();
  const desktop = isDesktopRuntime();

  const running = plugins.filter((p) => runtime[p.manifest.id]?.status === "running").length;
  const subtitle = loaded
    ? `${plugins.length} installed · ${running} running`
    : "Extend AETHER-OS with sandboxed, permission-scoped plugins";

  const reload = async () => {
    try {
      await refresh();
      await getPluginHost().restartAll();
      toast.success("Plugins reloaded");
    } catch (error) {
      toast.error("Plugins could not be reloaded", { description: message(error) });
    }
  };

  const openFolder = () => {
    openPluginsFolder().catch((error) => toast.error("Could not open the plugins folder", { description: message(error) }));
  };

  let body: JSX.Element;
  if (!desktop) {
    body = (
      <EmptyState
        icon={Blocks}
        title="Plugins run in the desktop app"
        description="Start AETHER-OS with npm run app (or the browser preview with npm run dev:mock)."
      />
    );
  } else if (!loaded) {
    body = (
      <div className="plugins-loading">
        <Spinner size={16} label="Loading plugins" />
      </div>
    );
  } else if (loadError) {
    body = (
      <div className="ui-notice ui-notice-danger plugins-load-error" role="alert">
        <span>Plugins could not be loaded: {loadError}</span>
        <Button size="sm" onClick={() => void refresh().catch(() => undefined)}>
          Try again
        </Button>
      </div>
    );
  } else if (plugins.length === 0) {
    body = (
      <EmptyState
        icon={Blocks}
        title="No plugins installed"
        description="Plugins add commands, panels and status bar items. Install one from a folder or a .zip archive."
        action={
          <Button variant="primary" iconLeft={<Plus size={14} />} onClick={() => setInstallOpen(true)}>
            Install plugin
          </Button>
        }
      />
    );
  } else {
    body = (
      <div className="plugins-layout">
        <section className="plugins-list" aria-label="Installed plugins">
          {plugins.map((plugin) => (
            <PluginCard key={plugin.manifest.id} plugin={plugin} />
          ))}
        </section>
        <PanelsArea />
      </div>
    );
  }

  return (
    <div className="view plugins-view">
      <ViewHeader
        title="Plugins"
        subtitle={subtitle}
        actions={
          desktop && (
            <>
              <Button variant="ghost" size="sm" iconLeft={<RotateCw size={14} />} onClick={() => void reload()}>
                Reload
              </Button>
              <Button variant="secondary" size="sm" iconLeft={<FolderOpen size={14} />} onClick={openFolder}>
                Open folder
              </Button>
              <Button variant="primary" size="sm" iconLeft={<Plus size={14} />} onClick={() => setInstallOpen(true)}>
                Install plugin
              </Button>
            </>
          )
        }
      />
      <div className="view-body">{body}</div>
      <InstallPluginModal />
      <PermissionsModal />
    </div>
  );
}
