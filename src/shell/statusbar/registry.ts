import { useSyncExternalStore, type ComponentType } from "react";
import { VaultStatusItem, IndexingStatusItem, ProvidersStatusItem } from "./items";
// Feature status item imports go directly above your anchor:
import { ClipboardStatusItem } from "../../components/clipboard/ClipboardStatusItem";
// @anchor:status-import:clipboard
// @anchor:status-import:search
import { HistoryStatusItem } from "../../components/history/HistoryStatusItem";
// @anchor:status-import:history
import { FocusStatusItem, PinsStatusItem } from "../../components/home/statusItems";
// @anchor:status-import:home
import { VaultTasksQuickAddHost, VaultTasksStatusItem } from "../../components/vaulttasks/VaultTasksStatusItem";
// @anchor:status-import:vaulttasks
import { RelatedStatusItem } from "../../components/intel/RelatedStatusItem";
// @anchor:status-import:intel
import { PluginStatusItems } from "../../components/plugins/PluginStatusItems";
// @anchor:status-import:plugins
// @anchor:status-import:export
import { SyncStatusItem } from "../../components/sync/SyncStatusItem";
// @anchor:status-import:sync
import { OllamaStatusItem } from "../../components/onboarding/OllamaStatusItem";
import { OnboardingHost } from "../../components/onboarding/OnboardingHost";
// @anchor:status-import:onboarding

/**
 * An item in the bottom status bar. Keep items tiny: an icon, a short
 * label or number, and a tooltip. Clicking may open a view or popover.
 */
export interface StatusItem {
  /** `"<feature>"` or `"<feature>.<name>"`, unique. */
  id: string;
  /** Sort key within its side; lower is further left. */
  order: number;
  component: ComponentType;
  /** Which side of the bar (default `left`). */
  align?: "left" | "right";
}

const items = new Map<string, StatusItem>();
const listeners = new Set<() => void>();
let snapshot: StatusItem[] = [];

function emit() {
  snapshot = Array.from(items.values()).sort((a, b) => a.order - b.order);
  listeners.forEach((l) => l());
}

/** Add (or replace by id) a status item. Returns an unregister function. */
export function registerStatusItem(item: StatusItem): () => void {
  items.set(item.id, item);
  emit();
  return () => {
    if (items.get(item.id) === item) {
      items.delete(item.id);
      emit();
    }
  };
}

/** All items sorted by `order`. */
export function getStatusItems(): StatusItem[] {
  return snapshot;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** React hook: status items for one side, sorted. */
export function useStatusItems(align: "left" | "right" = "left"): StatusItem[] {
  const all = useSyncExternalStore(subscribe, getStatusItems, getStatusItems);
  return all.filter((i) => (i.align ?? "left") === align);
}

// ── Built-in items ──────────────────────────────────────────────
// Orders: 100s vault, 200s AI, 300+ features. Feature agents add a
// `registerStatusItem({ ... });` line directly above their anchor.
registerStatusItem({ id: "core.vault", order: 100, component: VaultStatusItem });
registerStatusItem({ id: "core.indexing", order: 110, component: IndexingStatusItem });
registerStatusItem({ id: "core.providers", order: 200, component: ProvidersStatusItem });
registerStatusItem({ id: "clipboard", order: 300, component: ClipboardStatusItem });
// @anchor:status:clipboard
// @anchor:status:search
registerStatusItem({ id: "history", order: 320, component: HistoryStatusItem });
// @anchor:status:history
registerStatusItem({ id: "home.focus", order: 300, component: FocusStatusItem, align: "right" });
registerStatusItem({ id: "home.pins", order: 310, component: PinsStatusItem, align: "right" });
// @anchor:status:home
registerStatusItem({ id: "vaulttasks.due", order: 330, component: VaultTasksStatusItem });
registerStatusItem({ id: "vaulttasks.quickAdd", order: 331, component: VaultTasksQuickAddHost });
// @anchor:status:vaulttasks
registerStatusItem({ id: "intel.related", order: 340, component: RelatedStatusItem, align: "right" });
// @anchor:status:intel
registerStatusItem({ id: "plugins", order: 400, component: PluginStatusItems, align: "right" });
// @anchor:status:plugins
// @anchor:status:export
registerStatusItem({ id: "sync", order: 350, component: SyncStatusItem });
// @anchor:status:sync
registerStatusItem({ id: "onboarding.ollama", order: 210, component: OllamaStatusItem });
registerStatusItem({ id: "onboarding.host", order: 10_000, component: OnboardingHost, align: "right" });
// @anchor:status:onboarding
