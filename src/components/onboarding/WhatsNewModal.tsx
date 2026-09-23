import { Suspense, lazy, useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { readChangelog } from "../../lib/ipc";
import { useOnboardingStore } from "../../lib/onboardingStore";
import { APP_VERSION } from "../../lib/onboarding/appVersion";
import { releaseNotesFor, type ChangelogSection } from "../../lib/onboarding/changelog";
import { useShellStore } from "../../shell/shellStore";
import { Button, EmptyState, Modal, Spinner } from "../../ui";

const ReleaseNotes = lazy(() => import("./ReleaseNotes"));

/** Human date for a changelog section (`2026-10-01` → `October 1, 2026`). */
export function formatReleaseDate(date: string | null): string | null {
  if (!date) return null;
  const parsed = new Date(`${date}T12:00:00`);
  return Number.isNaN(parsed.getTime())
    ? date
    : parsed.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

/** "What's new" — the bundled changelog section of the running version. */
export function WhatsNewModal() {
  const open = useOnboardingStore((s) => s.whatsNewOpen);
  const close = useOnboardingStore((s) => s.closeWhatsNew);
  const openSettings = useShellStore((s) => s.openSettings);
  const [section, setSection] = useState<ChangelogSection | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setSection(undefined);
    setError(null);
    readChangelog()
      .then((md) => alive && setSection(releaseNotesFor(md, APP_VERSION)))
      .catch((e) => {
        if (!alive) return;
        setSection(null);
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [open]);

  if (!open) return null;

  const date = formatReleaseDate(section?.date ?? null);
  const heading =
    section && section.version !== "Unreleased" ? `What's new in ${section.version}` : `What's new in AETHER-OS ${APP_VERSION}`;

  return (
    <Modal
      open
      onClose={close}
      size="lg"
      icon={Sparkles}
      title={heading}
      description={date ? `Released ${date}` : section?.version === "Unreleased" ? "Development build — changes since the last release." : undefined}
      footerStart={
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            close();
            openSettings("updates");
          }}
        >
          Update settings
        </Button>
      }
      footer={
        <Button variant="primary" onClick={close} autoFocus>
          Got it
        </Button>
      }
    >
      {section === undefined ? (
        <div className="ob-loading">
          <Spinner size={14} /> Loading release notes…
        </div>
      ) : section === null ? (
        <EmptyState
          size="sm"
          icon={Sparkles}
          title="No release notes in this build"
          description={error ?? "The changelog bundled with this version is empty."}
        />
      ) : (
        <Suspense
          fallback={
            <div className="ob-loading">
              <Spinner size={14} />
            </div>
          }
        >
          <ReleaseNotes markdown={section.body} />
        </Suspense>
      )}
    </Modal>
  );
}
