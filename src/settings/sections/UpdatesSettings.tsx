import { Suspense, lazy, useEffect, useState } from "react";
import { ArrowUpRight, CircleArrowUp, CircleCheck, Sparkles } from "lucide-react";
import type { AppInfo } from "../../types";
import { getAppInfo, isDesktopRuntime } from "../../lib/ipc";
import { useOnboardingStore } from "../../lib/onboardingStore";
import { APP_VERSION } from "../../lib/onboarding/appVersion";
import { openExternalUrl } from "../../lib/onboarding/external";
import { useShellStore } from "../../shell/shellStore";
import { Badge, Button, Spinner, Switch, useToast } from "../../ui";
import { SettingsGroup, SettingsPage, SettingsRow } from "../layout";
import "../../styles/views/onboarding.css";

const ReleaseNotes = lazy(() => import("../../components/onboarding/ReleaseNotes"));

/** "3 minutes ago", "yesterday", or a date — for the last update check. */
export function formatLastCheck(at: number | null, now: number = Date.now()): string {
  if (at === null) return "Never checked";
  const minutes = Math.round((now - at) / 60_000);
  if (minutes < 1) return "Checked just now";
  if (minutes < 60) return `Checked ${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Checked ${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "Checked yesterday";
  if (days < 14) return `Checked ${days} days ago`;
  return `Checked on ${new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;
}

function formatPublished(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

/** Current version, the update check with release notes, and the automatic check. */
export function UpdatesSettings() {
  const toast = useToast();
  const update = useOnboardingStore((s) => s.update);
  const updateError = useOnboardingStore((s) => s.updateError);
  const checking = useOnboardingStore((s) => s.checkingUpdates);
  const checkUpdates = useOnboardingStore((s) => s.checkUpdates);
  const autoCheck = useOnboardingStore((s) => s.prefs.autoCheckUpdates);
  const lastCheck = useOnboardingStore((s) => s.prefs.lastUpdateCheckAt);
  const setPrefs = useOnboardingStore((s) => s.setPrefs);
  const openWhatsNew = useOnboardingStore((s) => s.openWhatsNew);
  const closeSettings = useShellStore((s) => s.closeSettings);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const desktop = isDesktopRuntime();

  useEffect(() => {
    if (!desktop) return;
    getAppInfo()
      .then(setInfo)
      .catch(() => undefined);
  }, [desktop]);

  const check = () => {
    void checkUpdates().catch(() => undefined);
  };

  const openRelease = async (url: string) => {
    try {
      await openExternalUrl(url);
    } catch (e) {
      toast.error("Could not open the release page", { description: e instanceof Error ? e.message : String(e) });
    }
  };

  const published = formatPublished(update?.published_at ?? null);

  return (
    <SettingsPage title="Updates" description="AETHER-OS checks GitHub for new releases. It never downloads or installs anything by itself.">
      <SettingsGroup>
        <SettingsRow
          label="Installed version"
          hint={info ? `Tauri ${info.tauri_version} · ${info.os} ${info.arch}` : undefined}
          control={<span className="settings-value mono">v{info?.version ?? APP_VERSION}</span>}
        />
        <SettingsRow
          label="Check for updates"
          hint={formatLastCheck(lastCheck)}
          control={
            <Button size="sm" variant="secondary" iconLeft={<CircleArrowUp size={13} />} loading={checking} onClick={check}>
              Check now
            </Button>
          }
        />
      </SettingsGroup>

      {checking && !update && (
        <div className="ob-loading">
          <Spinner size={14} /> Asking GitHub for the latest release…
        </div>
      )}

      {updateError && !checking && (
        <p className="ui-notice ui-notice-warning" role="alert">
          {updateError}
        </p>
      )}

      {update && (
        <SettingsGroup>
          <div className="obs-update-card">
            <div className="obs-update-head">
              {update.update_available ? (
                <CircleArrowUp size={18} className="ob-card-icon" />
              ) : (
                <CircleCheck size={18} className="ob-card-icon" />
              )}
              <div className="obs-update-title">
                {update.update_available ? `AETHER-OS ${update.latest} is available` : `You're up to date (${update.current})`}
              </div>
              {update.update_available && <Badge variant="accent">New</Badge>}
            </div>
            <p className="ob-muted">
              {update.update_available
                ? `You are on ${update.current}.${published ? ` Released ${published}.` : ""} Download it from the release page.`
                : published
                  ? `Latest release ${update.latest}, published ${published}.`
                  : "No newer release has been published."}
            </p>
            {update.update_available && update.notes.trim() && (
              <div className="obs-update-notes">
                <Suspense
                  fallback={
                    <div className="ob-loading">
                      <Spinner size={14} />
                    </div>
                  }
                >
                  <ReleaseNotes markdown={update.notes} />
                </Suspense>
              </div>
            )}
            <div className="obs-inline">
              <Button
                size="sm"
                variant={update.update_available ? "primary" : "ghost"}
                iconRight={<ArrowUpRight size={12} />}
                onClick={() => void openRelease(update.url)}
              >
                Open release page
              </Button>
            </div>
          </div>
        </SettingsGroup>
      )}

      <SettingsGroup title="Automatic">
        <SettingsRow
          label="Check once a day on launch"
          hint="One anonymous request to api.github.com. You get a notification when a new version is out."
          control={<Switch checked={autoCheck} onChange={(v) => setPrefs({ autoCheckUpdates: v })} aria-label="Check for updates once a day" />}
        />
        <SettingsRow
          label="What's new in this version"
          hint="The release notes bundled with this build."
          control={
            <Button
              size="sm"
              variant="ghost"
              iconLeft={<Sparkles size={13} />}
              onClick={() => {
                closeSettings();
                openWhatsNew();
              }}
            >
              Show
            </Button>
          }
        />
      </SettingsGroup>
    </SettingsPage>
  );
}
