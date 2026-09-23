/** Mock handler for `commands/updater_commands.rs`: reports a newer
 *  release so the update UI can be exercised in the browser preview. */
import pkg from "../../../package.json";
import type { UpdateInfo } from "../../types";
import { sleep, type MockHandlerMap } from "./runtime";

/** Next minor version after `current` (e.g. 0.1.0 → 0.2.0). */
function nextMinor(current: string): string {
  const [major = 0, minor = 0] = current.split(".").map((n) => Number.parseInt(n, 10) || 0);
  return `${major}.${minor + 1}.0`;
}

export const updaterHandlers: MockHandlerMap = {
  cmd_check_for_updates: async (): Promise<UpdateInfo> => {
    await sleep(600);
    const latest = nextMinor(pkg.version);
    return {
      current: pkg.version,
      latest,
      update_available: true,
      url: `https://github.com/EkexDon/AETHER-OS/releases/tag/v${latest}`,
      notes: `## AETHER-OS ${latest}\n\n- New design system with light and dark themes\n- Browser preview with a realistic mock backend\n- Local crash reports and diagnostics\n`,
      published_at: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    };
  },
};
