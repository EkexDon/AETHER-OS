import { useEffect } from "react";
import { startPluginHost } from "./host";

/**
 * Start the plugin host (idempotent). Used by the Plugins view and by
 * `PluginHostBootstrap` (always mounted by the shell), so enabled plugins
 * load at app start even if the view is never opened.
 */
export function usePluginHostBootstrap(): void {
  useEffect(() => {
    startPluginHost();
  }, []);
}
