import { useEffect, useState } from "react";
import { Sparkles, WandSparkles } from "lucide-react";
import { isDesktopRuntime } from "../../lib/ipc";
import { DEFAULT_GENERAL_PREFS, useOnboardingStore, type AgentPanelOnStart } from "../../lib/onboardingStore";
import { useShellStore } from "../../shell/shellStore";
import type { ViewMode } from "../../views/modes";
import { Badge, Button, SegmentedControl, Select, Switch, useToast } from "../../ui";
import { SettingsGroup, SettingsPage, SettingsRow } from "../layout";

interface ViewOption {
  mode: ViewMode;
  label: string;
}

/**
 * The registered views, loaded on demand so the settings registry does not
 * pull every view module in at import time.
 */
function useViewOptions(): ViewOption[] | null {
  const [views, setViews] = useState<ViewOption[] | null>(null);
  useEffect(() => {
    let alive = true;
    void import("../../views/registry")
      .then((m) => alive && setViews(m.VIEWS.map((v) => ({ mode: v.mode, label: v.label }))))
      .catch(() => alive && setViews([]));
    return () => {
      alive = false;
    };
  }, []);
  return views;
}

/** Start view, agent panel on start, quitting, language and the setup wizard. */
export function GeneralSettings() {
  const toast = useToast();
  const prefs = useOnboardingStore((s) => s.prefs);
  const setPrefs = useOnboardingStore((s) => s.setPrefs);
  const generalPrefs = useOnboardingStore((s) => s.generalPrefs);
  const loadGeneralPrefs = useOnboardingStore((s) => s.loadGeneralPrefs);
  const updateGeneralPrefs = useOnboardingStore((s) => s.updateGeneralPrefs);
  const openWizard = useOnboardingStore((s) => s.openWizard);
  const openWhatsNew = useOnboardingStore((s) => s.openWhatsNew);
  const closeSettings = useShellStore((s) => s.closeSettings);
  const views = useViewOptions();
  const desktop = isDesktopRuntime();
  const [generalError, setGeneralError] = useState<string | null>(null);

  useEffect(() => {
    if (!desktop) return;
    loadGeneralPrefs().catch((e: unknown) => setGeneralError(e instanceof Error ? e.message : String(e)));
  }, [desktop, loadGeneralPrefs]);

  const confirmQuit = (generalPrefs ?? DEFAULT_GENERAL_PREFS).confirm_quit_with_terminals;
  const setConfirmQuit = (value: boolean) => {
    setGeneralError(null);
    updateGeneralPrefs({ confirm_quit_with_terminals: value }).catch((e: unknown) =>
      toast.error("Could not save the setting", { description: e instanceof Error ? e.message : String(e) })
    );
  };

  const startOptions = (views ?? []).map((v) => ({ value: v.mode, label: v.label }));
  if (views && !views.some((v) => v.mode === prefs.startView)) {
    startOptions.unshift({ value: prefs.startView, label: `${prefs.startView} (not available)` });
  }

  return (
    <SettingsPage title="General" description="How AETHER-OS starts and speaks to you.">
      <SettingsGroup title="Startup">
        <SettingsRow
          label="Start view"
          hint="The workspace shown when the app opens."
          htmlFor="settings-start-view"
          control={
            <Select
              id="settings-start-view"
              className="settings-select"
              value={prefs.startView}
              disabled={!views}
              onChange={(e) => setPrefs({ startView: e.target.value as ViewMode })}
              options={views ? startOptions : [{ value: prefs.startView, label: "Loading…" }]}
            />
          }
        />
        <SettingsRow
          label="Agent panel on start"
          hint="“Remember” reopens the panel the way you left it."
          control={
            <SegmentedControl<AgentPanelOnStart>
              aria-label="Agent panel on start"
              value={prefs.agentPanelOnStart}
              onChange={(v) => setPrefs({ agentPanelOnStart: v })}
              options={[
                { value: "remember", label: "Remember" },
                { value: "open", label: "Open" },
                { value: "closed", label: "Closed" },
              ]}
            />
          }
        />
      </SettingsGroup>

      <SettingsGroup title="Quitting">
        <SettingsRow
          label="Confirm on quit with running terminals"
          hint={
            generalError
              ? `Could not load this setting: ${generalError}`
              : "Ask before ⌘Q closes AETHER-OS while terminal sessions are still running."
          }
          control={
            <Switch
              checked={confirmQuit}
              disabled={!desktop || generalPrefs === null}
              onChange={setConfirmQuit}
              aria-label="Confirm on quit with running terminals"
            />
          }
        />
      </SettingsGroup>

      <SettingsGroup title="Language">
        <SettingsRow
          label="Interface language"
          hint="AETHER-OS is English-only for now. The agent answers in whatever language you write to it."
          control={<Badge>English</Badge>}
        />
      </SettingsGroup>

      <SettingsGroup title="Setup & help">
        <SettingsRow
          label="Setup wizard"
          hint="Connect a vault, set up local AI and semantic search, and take the tour again."
          control={
            <Button
              size="sm"
              variant="secondary"
              iconLeft={<WandSparkles size={14} />}
              onClick={() => {
                closeSettings();
                openWizard({ restart: true });
              }}
            >
              Run setup again
            </Button>
          }
        />
        <SettingsRow
          label="“What's new” after updates"
          hint="Show the release notes once when AETHER-OS starts on a new version."
          control={
            <div className="obs-inline">
              <Button
                size="sm"
                variant="ghost"
                iconLeft={<Sparkles size={14} />}
                onClick={() => {
                  closeSettings();
                  openWhatsNew();
                }}
              >
                Show now
              </Button>
              <Switch
                checked={prefs.showWhatsNew}
                onChange={(v) => setPrefs({ showWhatsNew: v })}
                aria-label="Show what's new after updates"
              />
            </div>
          }
        />
      </SettingsGroup>
    </SettingsPage>
  );
}
