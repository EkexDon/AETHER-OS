import { useEffect } from "react";
import { ListChecks } from "lucide-react";
import { Tooltip } from "../../ui";
import { isDesktopRuntime } from "../../lib/ipc";
import { useAetherStore } from "../../lib/store";
import { useVaultTasksStore } from "../../lib/vaultTasksStore";
import { QuickAddModal } from "./QuickAdd";

const REFRESH_MS = 5 * 60_000;

/** Background refresh of the counters; failures only mean a stale chip. */
function refreshQuietly(): void {
  const store = useVaultTasksStore.getState();
  const job = store.loaded ? store.load({ silent: true }) : store.refreshStats();
  void job.catch(() => undefined);
}

/**
 * "3 due today" chip (or "2 overdue" when nothing is due today); hidden
 * when neither applies. Click opens Note Tasks filtered accordingly.
 */
export function VaultTasksStatusItem() {
  const vaultPath = useAetherStore((s) => s.vaultPath);
  const dueToday = useVaultTasksStore((s) => s.stats?.due_today ?? 0);
  const overdue = useVaultTasksStore((s) => s.stats?.overdue ?? 0);

  useEffect(() => {
    if (!vaultPath || !isDesktopRuntime()) return;
    refreshQuietly();
    const timer = window.setInterval(refreshQuietly, REFRESH_MS);
    window.addEventListener("focus", refreshQuietly);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshQuietly);
    };
  }, [vaultPath]);

  if (!vaultPath || (dueToday === 0 && overdue === 0)) return null;

  const open = () => {
    useVaultTasksStore.getState().showDuePreset(dueToday > 0 ? "today" : "overdue");
    useAetherStore.getState().setView("vaulttasks");
  };
  const label = dueToday > 0 ? `${dueToday} due today` : `${overdue} overdue`;
  const tooltip = [
    dueToday > 0 ? `${dueToday} task${dueToday === 1 ? "" : "s"} due today` : null,
    overdue > 0 ? `${overdue} overdue` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Tooltip content={`${tooltip} — open Note Tasks`} shortcut="mod+alt+c" placement="top">
      <button
        type="button"
        className={`statusbar-item vt-status${dueToday === 0 ? " is-overdue" : ""}`}
        onClick={open}
      >
        <ListChecks size={14} />
        <span className="statusbar-muted tabular">{label}</span>
        {dueToday > 0 && overdue > 0 && <span className="vt-status-extra tabular">+{overdue} overdue</span>}
      </button>
    </Tooltip>
  );
}

/**
 * Hosts the ⌘⇧T quick-add dialog. Mounted once for the whole session by
 * the shell's `FeatureHosts` slot.
 */
export function VaultTasksQuickAddHost() {
  const register = useVaultTasksStore((s) => s.registerQuickAddHost);
  useEffect(() => register(), [register]);
  return <QuickAddModal />;
}
