import { ArrowUpRight, BookOpen, Github, Keyboard } from "lucide-react";
import { version } from "../../../package.json";
import { browserOpen, isTauriRuntime } from "../../lib/ipc";
import { Button, toast } from "../../ui";
import { BrandMark } from "../../shell/BrandMark";
import { useShellStore } from "../../shell/shellStore";
import { SettingsGroup, SettingsPage, SettingsRow } from "../layout";

/** The app version, taken from `package.json` at build time. */
export const APP_VERSION: string = version;

const REPO_URL = "https://github.com/EkexDon/AETHER-OS";
const DOCS_URL = "https://github.com/EkexDon/AETHER-OS/blob/main/docs/TUTORIAL.md";

async function openExternal(url: string) {
  try {
    if (isTauriRuntime()) await browserOpen(url);
    else window.open(url, "_blank", "noopener,noreferrer");
  } catch (e) {
    toast.error("Could not open link", { description: e instanceof Error ? e.message : String(e) });
  }
}

/** Version, links and credits. */
export function AboutSettings() {
  const setShortcutsOpen = useShellStore((s) => s.setShortcutsOpen);
  const closeSettings = useShellStore((s) => s.closeSettings);

  return (
    <SettingsPage title="About">
      <div className="about-hero">
        <span className="about-mark">
          <BrandMark size={28} />
        </span>
        <div>
          <div className="about-name">AETHER-OS</div>
          <div className="about-tagline">A local-first operating system for your thoughts, projects and AI.</div>
        </div>
      </div>
      <SettingsGroup>
        <SettingsRow label="Version" control={<span className="settings-value mono">v{APP_VERSION}</span>} />
        <SettingsRow
          label="Data"
          hint="Notes stay in your vault folder; app data lives in ~/Library/Application Support/com.ekin.aetheros."
        />
        <SettingsRow
          label="Keyboard shortcuts"
          hint="Everything in AETHER-OS is reachable from the keyboard."
          control={
            <Button
              variant="secondary"
              size="sm"
              iconLeft={<Keyboard size={13} />}
              onClick={() => {
                closeSettings();
                setShortcutsOpen(true);
              }}
            >
              Show shortcuts
            </Button>
          }
        />
      </SettingsGroup>
      <SettingsGroup title="Links">
        <SettingsRow
          label="Source code"
          hint="github.com/EkexDon/AETHER-OS"
          control={
            <Button variant="ghost" size="sm" iconLeft={<Github size={13} />} iconRight={<ArrowUpRight size={12} />} onClick={() => void openExternal(REPO_URL)}>
              GitHub
            </Button>
          }
        />
        <SettingsRow
          label="Tutorial"
          hint="A guided tour through every workspace."
          control={
            <Button variant="ghost" size="sm" iconLeft={<BookOpen size={13} />} iconRight={<ArrowUpRight size={12} />} onClick={() => void openExternal(DOCS_URL)}>
              Open
            </Button>
          }
        />
      </SettingsGroup>
    </SettingsPage>
  );
}
