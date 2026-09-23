/**
 * Static palette commands of the plugin system. Commands contributed by
 * plugins themselves are registered at runtime by `PluginHost` under the
 * same "Plugins" group.
 */
import { FolderOpen, PackagePlus, RotateCw } from "lucide-react";
import type { CommandContribution } from "../commands/registry";
import { isDesktopRuntime, openPluginsFolder } from "../ipc";
import { usePluginsStore } from "../pluginsStore";
import { getPluginHost, PLUGIN_COMMAND_GROUP } from "./host";

/** "Install plugin…", "Reload plugins", "Open plugins folder". */
export const pluginsCommands: CommandContribution[] = [
  {
    id: "plugins.install",
    title: "Install plugin…",
    group: PLUGIN_COMMAND_GROUP,
    icon: PackagePlus,
    shortcut: "mod+alt+shift+i",
    keywords: ["plugin", "extension", "add-on", "zip", "folder"],
    run: (ctx) => {
      ctx.setView("plugins");
      usePluginsStore.getState().setInstallOpen(true);
    },
    when: () => isDesktopRuntime(),
  },
  {
    id: "plugins.reload",
    title: "Reload plugins",
    group: PLUGIN_COMMAND_GROUP,
    icon: RotateCw,
    shortcut: "mod+alt+shift+r",
    keywords: ["plugin", "restart", "refresh", "extension"],
    run: async (ctx) => {
      await usePluginsStore.getState().refresh();
      await getPluginHost().restartAll();
      ctx.toast.success("Plugins reloaded");
    },
    when: () => isDesktopRuntime(),
  },
  {
    id: "plugins.openFolder",
    title: "Open plugins folder",
    group: PLUGIN_COMMAND_GROUP,
    icon: FolderOpen,
    keywords: ["plugin", "finder", "directory", "extension"],
    run: () => openPluginsFolder(),
    when: () => isDesktopRuntime(),
  },
];
