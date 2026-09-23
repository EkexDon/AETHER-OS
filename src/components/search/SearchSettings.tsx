import { useCallback, useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { FolderPlus, History, Keyboard, RefreshCw, X } from "lucide-react";
import type { SearchKind, SearchSettings as Settings, SearchStatus } from "../../types";
import {
  clearSearchRecents,
  getSearchSettings,
  getSearchStatus,
  isDesktopRuntime,
  isTauriRuntime,
  onSearchIndexUpdated,
  setSearchSettings,
} from "../../lib/ipc";
import { useSearchStore } from "../../lib/searchStore";
import { SEARCH_KINDS, SECTION_META } from "../../lib/search/kinds";
import { Badge, Button, Checkbox, IconButton, Input, Spinner, Switch, useToast } from "../../ui";
import { SettingsGroup, SettingsPage, SettingsRow } from "../../settings/layout";
import { relativeAge } from "./SearchResultCard";
import "../../styles/views/search.css";

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Readable form of an accelerator for the hint (`CommandOrControl` → `Cmd/Ctrl`). */
export function describeAccelerator(accelerator: string): string {
  return accelerator
    .split("+")
    .map((p) => p.trim())
    .map((p) => (/^(commandorcontrol|cmdorctrl|cmdorcontrol|commandorctrl)$/i.test(p) ? "Cmd/Ctrl" : p))
    .join(" + ");
}

/**
 * Settings → Search: the system-wide launcher shortcut, which kinds are
 * indexed, the folders whose files are indexed, index status, reindex and
 * clearing recents.
 */
export function SearchSettings() {
  const toast = useToast();
  const reindex = useSearchStore((s) => s.reindex);
  const reindexing = useSearchStore((s) => s.reindexing);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [status, setStatus] = useState<SearchStatus | null>(null);
  const [shortcutDraft, setShortcutDraft] = useState("");
  const [shortcutError, setShortcutError] = useState<string | null>(null);
  const [rootDraft, setRootDraft] = useState("");
  const [rootError, setRootError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const desktop = isDesktopRuntime();

  const refreshStatus = useCallback(() => {
    void getSearchStatus()
      .then(setStatus)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void getSearchSettings()
      .then((s) => {
        if (disposed) return;
        setSettings(s);
        setShortcutDraft(s.global_shortcut);
      })
      .catch((e) => setLoadError(errorText(e)));
    refreshStatus();
    void onSearchIndexUpdated(refreshStatus).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [desktop, refreshStatus]);

  /** Persist a change; returns the error message (also toasted) or `null`. */
  const save = async (next: Settings, successMessage?: string): Promise<string | null> => {
    setSaving(true);
    try {
      const saved = await setSearchSettings(next);
      setSettings(saved);
      setShortcutDraft(saved.global_shortcut);
      if (successMessage) toast.success(successMessage);
      // The backend re-registers the shortcut synchronously; refresh its state.
      refreshStatus();
      return null;
    } catch (e) {
      const message = errorText(e);
      toast.error("Could not save search settings", { description: message });
      return message;
    } finally {
      setSaving(false);
    }
  };

  if (!desktop) {
    return (
      <SettingsPage title="Search" description="Launcher and universal search.">
        <div className="ui-notice">Search settings are available in the desktop app.</div>
      </SettingsPage>
    );
  }

  if (!settings) {
    return (
      <SettingsPage title="Search" description="Launcher and universal search.">
        {loadError ? (
          <div className="ui-notice ui-notice-danger" role="alert">
            {loadError}
          </div>
        ) : (
          <Spinner size={16} label="Loading search settings" />
        )}
      </SettingsPage>
    );
  }

  const countOf = (kind: SearchKind) => status?.counts.find((c) => c.kind === kind)?.count ?? 0;

  const applyShortcut = async () => {
    const value = shortcutDraft.trim();
    if (value === settings.global_shortcut) return;
    const error = await save({ ...settings, global_shortcut: value }, `Launcher shortcut set to ${value}`);
    setShortcutError(error);
  };

  const toggleKind = (kind: SearchKind, on: boolean) => {
    const kinds = on ? SEARCH_KINDS.filter((k) => k === kind || settings.kinds.includes(k)) : settings.kinds.filter((k) => k !== kind);
    if (kinds.length === 0) {
      toast.error("Keep at least one kind of result");
      return;
    }
    void save({ ...settings, kinds });
  };

  const addRoot = async (path: string) => {
    const trimmed = path.trim();
    if (!trimmed) return;
    if (settings.file_roots.includes(trimmed)) {
      setRootError("This folder is already indexed.");
      return;
    }
    const error = await save({ ...settings, file_roots: [...settings.file_roots, trimmed] }, "Folder added — indexing its files");
    setRootError(error);
    if (!error) setRootDraft("");
  };

  const browse = async () => {
    try {
      const picked = await openDialog({ directory: true, multiple: false, title: "Index files in folder" });
      if (typeof picked === "string") await addRoot(picked);
    } catch (e) {
      toast.error("Could not open the folder picker", { description: errorText(e) });
    }
  };

  const onReindex = async () => {
    await reindex();
    refreshStatus();
  };

  const clearRecents = async () => {
    try {
      await clearSearchRecents();
      toast.success("Recent results cleared");
    } catch (e) {
      toast.error("Could not clear recents", { description: errorText(e) });
    }
  };

  return (
    <SettingsPage
      title="Search"
      description="The launcher (⌘K) and the Search view search one local index of your notes, projects, files, apps, events, tasks, memory and AI conversations."
    >
      <SettingsGroup title="Launcher" description="Open the launcher from anywhere on your Mac, even when AETHER-OS is in the background.">
        <SettingsRow
          label="System-wide shortcut"
          hint={
            status?.shortcut_error ? (
              <span className="search-settings-error">{status.shortcut_error}</span>
            ) : status?.shortcut ? (
              `Active: ${describeAccelerator(status.shortcut)}`
            ) : settings.global_shortcut_enabled ? (
              "Not registered yet."
            ) : (
              "Off — use ⌘K inside the app."
            )
          }
          control={
            <Switch
              checked={settings.global_shortcut_enabled}
              onChange={(on) => void save({ ...settings, global_shortcut_enabled: on })}
              aria-label="System-wide launcher shortcut"
              disabled={saving}
            />
          }
        />
        <SettingsRow
          label="Shortcut"
          htmlFor="search-shortcut"
          hint={
            shortcutError ? (
              <span className="search-settings-error">{shortcutError}</span>
            ) : (
              "Modifiers first, then one key — e.g. Alt+Space, CommandOrControl+Shift+Space, Ctrl+Alt+K."
            )
          }
          control={
            <div className="search-settings-inline">
              <Input
                id="search-shortcut"
                size="sm"
                className="search-settings-shortcut"
                iconLeft={<Keyboard size={13} />}
                value={shortcutDraft}
                invalid={!!shortcutError}
                disabled={!settings.global_shortcut_enabled || saving}
                onChange={(e) => {
                  setShortcutDraft(e.target.value);
                  setShortcutError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void applyShortcut();
                  }
                }}
              />
              <Button
                size="sm"
                disabled={!settings.global_shortcut_enabled || saving || shortcutDraft.trim() === settings.global_shortcut}
                onClick={() => void applyShortcut()}
              >
                Apply
              </Button>
            </div>
          }
        />
      </SettingsGroup>

      <SettingsGroup title="What to search" description="Unchecked kinds are removed from the index and never shown.">
        <div className="search-settings-kinds">
          {SEARCH_KINDS.map((kind) => {
            const meta = SECTION_META[kind];
            const Icon = meta.icon;
            const on = settings.kinds.includes(kind);
            return (
              <div key={kind} className="search-settings-kind">
                <Checkbox
                  checked={on}
                  disabled={saving}
                  onChange={(checked) => toggleKind(kind, checked)}
                  label={
                    <span className="search-settings-kind-label">
                      <Icon size={14} aria-hidden="true" /> {meta.label}
                    </span>
                  }
                />
                {on && (
                  <Badge size="sm" className="tabular">
                    {countOf(kind).toLocaleString()}
                  </Badge>
                )}
              </div>
            );
          })}
        </div>
      </SettingsGroup>

      <SettingsGroup
        title="File index folders"
        description="Only names and paths are indexed (never contents); .gitignore rules are respected, node_modules/target/.git skipped, up to 50 000 files."
      >
        {settings.file_roots.length === 0 ? (
          <p className="search-settings-hint">Every project folder from the Projects view is indexed. Add folders to index those instead.</p>
        ) : (
          <ul className="search-settings-roots">
            {settings.file_roots.map((root) => (
              <li key={root} className="search-settings-root">
                <span className="mono">{root}</span>
                <IconButton
                  size="sm"
                  label={`Stop indexing ${root}`}
                  icon={<X size={13} />}
                  disabled={saving}
                  onClick={() => void save({ ...settings, file_roots: settings.file_roots.filter((r) => r !== root) })}
                />
              </li>
            ))}
          </ul>
        )}
        <SettingsRow
          label="Add folder"
          htmlFor="search-root"
          stacked
          hint={rootError ? <span className="search-settings-error">{rootError}</span> : "An absolute path, e.g. /Users/you/Developer."}
        >
          <div className="search-settings-inline">
            <Input
              id="search-root"
              size="sm"
              className="search-settings-root-input"
              placeholder="/Users/you/Developer"
              value={rootDraft}
              invalid={!!rootError}
              onChange={(e) => {
                setRootDraft(e.target.value);
                setRootError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void addRoot(rootDraft);
                }
              }}
            />
            <Button size="sm" disabled={!rootDraft.trim() || saving} onClick={() => void addRoot(rootDraft)}>
              Add
            </Button>
            {isTauriRuntime() && (
              <Button size="sm" iconLeft={<FolderPlus size={13} />} disabled={saving} onClick={() => void browse()}>
                Browse…
              </Button>
            )}
          </div>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Index">
        <SettingsRow
          label="Status"
          hint={
            status
              ? `${status.total.toLocaleString()} items${status.last_indexed_at ? ` · last full index ${relativeAge(status.last_indexed_at)}` : ""}${status.indexing ? " · indexing now" : ""}. Notes are re-scanned automatically as you search.`
              : "Loading…"
          }
          control={
            <Button size="sm" iconLeft={<RefreshCw size={13} />} loading={reindexing} onClick={() => void onReindex()}>
              Reindex now
            </Button>
          }
        />
        <SettingsRow
          label="Recent results"
          hint="The launcher shows recently opened results and ranks frequently used ones higher."
          control={
            <Button size="sm" variant="ghost" iconLeft={<History size={13} />} onClick={() => void clearRecents()}>
              Clear recents
            </Button>
          }
        />
      </SettingsGroup>
    </SettingsPage>
  );
}
