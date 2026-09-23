import { ArrowUpRight, BookOpen, Github, Keyboard, ScrollText } from "lucide-react";
import { APP_VERSION as VERSION } from "../../lib/onboarding/appVersion";
import { openExternalUrl } from "../../lib/onboarding/external";
import { Button, toast } from "../../ui";
import { BrandMark } from "../../shell/BrandMark";
import { useShellStore } from "../../shell/shellStore";
import { SettingsGroup, SettingsPage, SettingsRow } from "../layout";

/** The app version, taken from `package.json` at build time. */
export const APP_VERSION: string = VERSION;

const REPO_URL = "https://github.com/EkexDon/AETHER-OS";
const DOCS_URL = "https://github.com/EkexDon/AETHER-OS/blob/main/docs/TUTORIAL.md";
const RELEASES_URL = "https://github.com/EkexDon/AETHER-OS/releases";

/** Major open-source projects AETHER-OS is built on, with their licenses. */
export const CREDITS: { name: string; role: string; license: string }[] = [
  { name: "Tauri", role: "Desktop shell and IPC", license: "MIT / Apache-2.0" },
  { name: "Rust & Tokio", role: "Backend and async runtime", license: "MIT / Apache-2.0" },
  { name: "React", role: "User interface", license: "MIT" },
  { name: "Tiptap & ProseMirror", role: "Note editor", license: "MIT" },
  { name: "Monaco Editor", role: "IDE editor", license: "MIT" },
  { name: "CodeMirror", role: "Markdown source editing", license: "MIT" },
  { name: "xterm.js & portable-pty", role: "Terminal", license: "MIT" },
  { name: "libgit2 (git2-rs)", role: "Source control", license: "GPL-2.0 with linking exception / MIT" },
  { name: "SQLite (rusqlite)", role: "Local databases", license: "Public domain / MIT" },
  { name: "Ollama", role: "Local models (runs separately)", license: "MIT" },
  { name: "Mermaid", role: "Diagrams", license: "MIT" },
  { name: "Lucide", role: "Icons", license: "ISC" },
  { name: "IBM Plex Sans", role: "Interface typeface", license: "SIL OFL 1.1" },
  { name: "JetBrains Mono", role: "Code typeface", license: "SIL OFL 1.1" },
];

async function openLink(url: string) {
  try {
    await openExternalUrl(url);
  } catch (e) {
    toast.error("Could not open link", { description: e instanceof Error ? e.message : String(e) });
  }
}

/** Version, links, credits and the license note. */
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
          hint="Notes stay in your vault folder; app data lives in ~/Library/Application Support/com.ekin.aetheros. Details in Data & Privacy."
        />
        <SettingsRow
          label="Keyboard shortcuts"
          hint="Everything in AETHER-OS is reachable from the keyboard."
          control={
            <Button
              variant="secondary"
              size="sm"
              iconLeft={<Keyboard size={14} />}
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
            <Button variant="ghost" size="sm" iconLeft={<Github size={14} />} iconRight={<ArrowUpRight size={14} />} onClick={() => void openLink(REPO_URL)}>
              GitHub
            </Button>
          }
        />
        <SettingsRow
          label="Releases"
          hint="Release notes and downloads for every version."
          control={
            <Button variant="ghost" size="sm" iconLeft={<ScrollText size={14} />} iconRight={<ArrowUpRight size={14} />} onClick={() => void openLink(RELEASES_URL)}>
              Releases
            </Button>
          }
        />
        <SettingsRow
          label="Tutorial"
          hint="A guided tour through every workspace."
          control={
            <Button variant="ghost" size="sm" iconLeft={<BookOpen size={14} />} iconRight={<ArrowUpRight size={14} />} onClick={() => void openLink(DOCS_URL)}>
              Open
            </Button>
          }
        />
      </SettingsGroup>
      <SettingsGroup title="Built with" description="Thank you to the open-source projects AETHER-OS stands on.">
        <ul className="obs-credits">
          {CREDITS.map((c) => (
            <li key={c.name}>
              <span className="obs-credit-name">{c.name}</span>
              <span className="obs-credit-meta">
                {c.role} · {c.license}
              </span>
            </li>
          ))}
        </ul>
      </SettingsGroup>
      <SettingsGroup title="License">
        <SettingsRow
          label="AETHER-OS"
          hint="A private project, not yet open-sourced. The libraries above keep their own licenses; their notices ship with the source."
        />
      </SettingsGroup>
    </SettingsPage>
  );
}
