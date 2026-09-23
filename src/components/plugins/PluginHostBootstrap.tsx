import { usePluginHostBootstrap } from "../../lib/plugins/useBootstrap";

/**
 * Starts the plugin host at app launch so enabled plugins run even if the
 * Plugins view is never opened. Renders nothing; mounted once by the
 * shell's `FeatureHosts`.
 */
export function PluginHostBootstrap() {
  usePluginHostBootstrap();
  return null;
}
