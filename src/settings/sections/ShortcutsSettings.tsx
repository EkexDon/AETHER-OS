import { useMemo, useState } from "react";
import { ClipboardCopy, FilePlus2, Keyboard } from "lucide-react";
import { runCommand, useCommands } from "../../lib/commands/registry";
import { createNote } from "../../lib/ipc";
import { useAetherStore } from "../../lib/store";
import { buildCheatSheet, collectShortcuts, filterShortcuts, withShortcutsOnly } from "../../lib/onboarding/cheatsheet";
import { copyText } from "../../lib/onboarding/clipboard";
import { APP_VERSION } from "../../lib/onboarding/appVersion";
import { useShellStore } from "../../shell/shellStore";
import { Button, EmptyState, Kbd, SearchField, Switch, useToast } from "../../ui";
import { SettingsGroup, SettingsPage } from "../layout";

/** Vault-relative file name used by "Save as note". */
export const CHEAT_SHEET_NOTE = "AETHER-OS shortcuts.md";

/** Every command and editor shortcut, searchable and grouped, plus the cheat sheet export. */
export function ShortcutsSettings() {
  const toast = useToast();
  const commands = useCommands();
  const closeSettings = useShellStore((s) => s.closeSettings);
  const vaultPath = useAetherStore((s) => s.vaultPath);
  const [query, setQuery] = useState("");
  const [onlyBound, setOnlyBound] = useState(false);
  const [saving, setSaving] = useState(false);

  const all = useMemo(() => collectShortcuts(commands), [commands]);
  const groups = useMemo(() => {
    const filtered = filterShortcuts(all, query);
    return onlyBound ? withShortcutsOnly(filtered) : filtered;
  }, [all, query, onlyBound]);
  const total = all.reduce((n, g) => n + g.entries.filter((e) => e.shortcut).length, 0);

  const markdown = () => buildCheatSheet(all, { version: APP_VERSION });

  const copy = async () => {
    try {
      await copyText(markdown());
      toast.success("Cheat sheet copied", { description: "A Markdown table of every shortcut — paste it anywhere." });
    } catch (e) {
      toast.error("Could not copy", { description: e instanceof Error ? e.message : String(e) });
    }
  };

  const saveNote = async () => {
    setSaving(true);
    try {
      const path = await createNote(CHEAT_SHEET_NOTE, markdown());
      toast.success("Cheat sheet saved to your vault", {
        description: path,
        action: {
          label: "Open",
          onClick: () => {
            const store = useAetherStore.getState();
            store.selectNote(path);
            store.setView("editor");
            closeSettings();
          },
        },
      });
    } catch (e) {
      toast.error("Could not save the note", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  };

  const run = (id: string) => {
    closeSettings();
    void runCommand(id).catch(() => undefined);
  };

  return (
    <SettingsPage
      title="Shortcuts"
      description={`${total} keyboard shortcuts. Click a command to run it; everything is also in the command palette.`}
    >
      <div className="obs-inline">
        <SearchField value={query} onChange={setQuery} placeholder="Find a command or key" size="sm" aria-label="Filter shortcuts" />
        <Switch checked={onlyBound} onChange={setOnlyBound} label="Only with a shortcut" size="sm" />
      </div>
      <div className="obs-inline">
        <Button size="sm" variant="secondary" iconLeft={<ClipboardCopy size={14} />} onClick={() => void copy()}>
          Copy cheat sheet
        </Button>
        <Button
          size="sm"
          variant="ghost"
          iconLeft={<FilePlus2 size={14} />}
          loading={saving}
          disabled={!vaultPath}
          title={vaultPath ? undefined : "Connect a vault first"}
          onClick={() => void saveNote()}
        >
          Save as note
        </Button>
      </div>

      {groups.length === 0 ? (
        <EmptyState icon={Keyboard} size="sm" title="No matching shortcuts" description="Try another word or key." />
      ) : (
        groups.map((g) => (
          <SettingsGroup key={g.group} title={g.group} className="obs-shortcut-group">
            {g.entries.map((e) =>
              e.runnable ? (
                <button key={e.id} type="button" className="obs-shortcut-row" onClick={() => run(e.id)}>
                  <span className="obs-shortcut-title">{e.title}</span>
                  {e.shortcut ? <Kbd shortcut={e.shortcut} /> : <span className="obs-shortcut-none">No shortcut</span>}
                </button>
              ) : (
                <div key={e.id} className="obs-shortcut-row">
                  <span className="obs-shortcut-title">{e.title}</span>
                  {e.shortcut && <Kbd shortcut={e.shortcut} />}
                </div>
              )
            )}
          </SettingsGroup>
        ))
      )}
    </SettingsPage>
  );
}
