import { useEffect } from "react";
import { startPluginHost } from "./host";

/**
 * Start the plugin host (idempotent). Mounted by the Plugins view and by the
 * always-visible plugin status bar item, so enabled plugins load at app
 * start even if the view is never opened.
 */
export function usePluginHostBootstrap(): void {
  useEffect(() => {
    startPluginHost();
  }, []);
}
