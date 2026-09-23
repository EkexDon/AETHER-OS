import type { ComponentType } from "react";
import { OnboardingHost } from "../components/onboarding/OnboardingHost";
import { VaultTasksQuickAddHost } from "../components/vaulttasks/VaultTasksStatusItem";
import { PluginHostBootstrap } from "../components/plugins/PluginHostBootstrap";
import { QuitConfirmHost } from "./QuitConfirmHost";
import { ShellErrorBoundary } from "./ErrorBoundary";

/** A feature component that must live for the whole session but has no place in the layout. */
export interface FeatureHost {
  /** `"<feature>.<name>"`, used as the error-boundary label. */
  id: string;
  component: ComponentType;
}

/**
 * Always-mounted feature hosts: they own overlays (portaled to
 * `document.body`), background start-up work or event subscriptions.
 * Rendered once by `App`, outside the view host, so switching views never
 * remounts them. Each host is isolated: a crash hides only that host.
 */
export const FEATURE_HOSTS: FeatureHost[] = [
  { id: "onboarding.host", component: OnboardingHost },
  { id: "vaulttasks.quickAdd", component: VaultTasksQuickAddHost },
  { id: "plugins.bootstrap", component: PluginHostBootstrap },
  { id: "shell.quitConfirm", component: QuitConfirmHost },
];

/** The slot `App` renders once; see {@link FEATURE_HOSTS}. */
export function FeatureHosts({ hosts = FEATURE_HOSTS }: { hosts?: FeatureHost[] }) {
  return (
    <>
      {hosts.map(({ id, component: Host }) => (
        <ShellErrorBoundary key={id} fallback={null} label={id}>
          <Host />
        </ShellErrorBoundary>
      ))}
    </>
  );
}
