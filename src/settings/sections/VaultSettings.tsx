import { useEffect, useState } from "react";
import { Check, FolderOpen, FolderPlus, FolderSearch, SquareArrowOutUpRight } from "lucide-react";
import type { VaultInfo, VaultPrefs } from "../../types";
import { useAetherStore } from "../../lib/store";
import {
  createStarterVault,
  detectVaults,
  getVaultPath,
  getVaultPrefs,
  isDesktopRuntime,
  revealVault,
  setVaultPrefs,
  suggestVaultPath,
} from "../../lib/ipc";
import { canPickFolder, connectVault, folderName, pickFolder } from "../../lib/onboarding/vaultActions";
import { Badge, Button, EmptyState, Input, Spinner, useToast } from "../../ui";
import { SettingsGroup, SettingsPage, SettingsRow } from "../layout";
import "../../styles/views/onboarding.css";

const KIND_LABEL: Record<VaultInfo["kind"], string> = { nopes: "NoPes", obsidian: "Obsidian", plain: "Markdown" };

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Preview of a daily-note file name for today (`YYYY-MM-DD` → `2026-09-23.md`). */
export function previewDailyName(pattern: string, date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pattern
    .replace(/YYYY/g, String(date.getFullYear()))
    .replace(/MM/g, pad(date.getMonth() + 1))
    .replace(/DD/g, pad(date.getDate()))}.md`;
}

/** Vault location, stats, starter vault creation and daily-note preferences. */
export function VaultSettings() {
  const toast = useToast();
  const vaultPath = useAetherStore((s) => s.vaultPath);
  const setStoreVaultPath = useAetherStore((s) => s.setVaultPath);
  const vaultStats = useAetherStore((s) => s.vaultStats);
  const health = useAetherStore((s) => s.health);
  const [pathInput, setPathInput] = useState(vaultPath ?? "");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newPath, setNewPath] = useState("");
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [found, setFound] = useState<VaultInfo[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [prefs, setPrefs] = useState<VaultPrefs | null>(null);
  const [prefsDraft, setPrefsDraft] = useState<VaultPrefs>({ daily_folder: "daily", daily_filename_pattern: "YYYY-MM-DD" });
  const [prefsError, setPrefsError] = useState<string | null>(null);
  const [savingPrefs, setSavingPrefs] = useState(false);
  const desktop = isDesktopRuntime();

  useEffect(() => {
    if (!desktop) return;
    void getVaultPath()
      .then((p) => {
        if (p) {
          setStoreVaultPath(p);
          setPathInput(p);
        }
      })
      .catch(() => undefined);
    void getVaultPrefs()
      .then((p) => {
        setPrefs(p);
        setPrefsDraft(p);
      })
      .catch((e) => setPrefsError(errorText(e)));
  }, [desktop, setStoreVaultPath]);

  const save = async (path = pathInput) => {
    if (!path.trim()) return;
    setStatus("saving");
    setError(null);
    try {
      await connectVault(path);
      setPathInput(path.trim());
      setStatus("saved");
      window.setTimeout(() => setStatus("idle"), 2000);
    } catch (e) {
      setError(errorText(e));
      setStatus("error");
    }
  };

  const browse = async () => {
    try {
      const picked = await pickFolder();
      if (picked) setPathInput(picked);
    } catch (e) {
      setError(errorText(e));
    }
  };

  const startCreate = async () => {
    setCreating(true);
    setCreateError(null);
    if (!newPath) {
      try {
        setNewPath(await suggestVaultPath());
      } catch (e) {
        setCreateError(errorText(e));
      }
    }
  };

  const create = async () => {
    setCreateBusy(true);
    setCreateError(null);
    try {
      const info = await createStarterVault(newPath);
      await connectVault(info.path);
      setPathInput(info.path);
      setCreating(false);
      setNewPath("");
      toast.success("Starter vault created", { description: `${info.note_count} notes in ${info.name}` });
    } catch (e) {
      setCreateError(errorText(e));
    } finally {
      setCreateBusy(false);
    }
  };

  const scan = async () => {
    setScanning(true);
    try {
      setFound(await detectVaults());
    } catch (e) {
      toast.error("Could not look for vaults", { description: errorText(e) });
    } finally {
      setScanning(false);
    }
  };

  const reveal = async () => {
    try {
      await revealVault();
    } catch (e) {
      toast.error("Could not reveal the vault", { description: errorText(e) });
    }
  };

  const savePrefs = async () => {
    setSavingPrefs(true);
    setPrefsError(null);
    try {
      const stored = await setVaultPrefs(prefsDraft);
      setPrefs(stored);
      setPrefsDraft(stored);
      toast.success("Daily note settings saved");
    } catch (e) {
      setPrefsError(errorText(e));
    } finally {
      setSavingPrefs(false);
    }
  };

  const connected = !!(health?.vault_connected || vaultPath);
  const prefsDirty =
    !!prefs &&
    (prefs.daily_folder !== prefsDraft.daily_folder.trim() || prefs.daily_filename_pattern !== prefsDraft.daily_filename_pattern.trim());

  return (
    <SettingsPage
      title="Vault"
      description="The folder of Markdown notes AETHER-OS reads and writes. Obsidian and NoPes vaults work as they are."
    >
      <SettingsGroup>
        <SettingsRow label="Vault folder" hint="Notes stay plain Markdown files on disk." stacked htmlFor="settings-vault-path">
          <div className="ui-field-row">
            <Input
              id="settings-vault-path"
              value={pathInput}
              onChange={(e) => setPathInput(e.target.value)}
              placeholder="/path/to/your/vault"
              invalid={status === "error"}
              spellCheck={false}
              onKeyDown={(e) => {
                if (e.key === "Enter") void save();
              }}
            />
            {canPickFolder() && (
              <Button variant="secondary" iconLeft={<FolderOpen size={14} />} onClick={() => void browse()}>
                Browse
              </Button>
            )}
            <Button
              variant="primary"
              onClick={() => void save()}
              loading={status === "saving"}
              disabled={!pathInput.trim() || pathInput.trim() === vaultPath}
              iconLeft={status === "saved" ? <Check size={14} /> : undefined}
            >
              {status === "saved" ? "Saved" : "Use folder"}
            </Button>
          </div>
          {error && <p className="ui-field-error settings-inline-error">{error}</p>}
        </SettingsRow>
        <SettingsRow
          label="Status"
          hint={vaultStats ? `${vaultStats.open_tasks} open of ${vaultStats.total_tasks} tasks · ${vaultStats.total_tags} tags · ${vaultStats.total_links} links` : "Counts refresh whenever notes change."}
          control={
            <div className="settings-badges">
              <Badge variant={connected ? "success" : "neutral"} dot>
                {connected ? "Connected" : "Not connected"}
              </Badge>
              {vaultStats && <Badge>{vaultStats.note_count} notes</Badge>}
            </div>
          }
        />
        <SettingsRow
          label="Show in Finder"
          hint={vaultPath ? folderName(vaultPath) : "Connect a vault first."}
          control={
            <Button size="sm" variant="ghost" iconLeft={<SquareArrowOutUpRight size={13} />} disabled={!vaultPath} onClick={() => void reveal()}>
              Reveal
            </Button>
          }
        />
      </SettingsGroup>

      <SettingsGroup title="New or existing vault">
        <SettingsRow
          label="Create a starter vault"
          hint="A fresh folder with Welcome, a guide to links, tags and tasks, today's daily note, Projects/ and Resources/."
          stacked={creating}
          control={
            creating ? undefined : (
              <Button size="sm" variant="secondary" iconLeft={<FolderPlus size={13} />} onClick={() => void startCreate()}>
                Create new vault
              </Button>
            )
          }
        >
          {creating && (
            <>
              <div className="ui-field-row">
                <Input
                  aria-label="New vault folder"
                  value={newPath}
                  onChange={(e) => setNewPath(e.target.value)}
                  spellCheck={false}
                  invalid={!!createError}
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && newPath.trim()) void create();
                    if (e.key === "Escape") {
                      e.preventDefault();
                      setCreating(false);
                    }
                  }}
                />
                <Button variant="ghost" onClick={() => setCreating(false)}>
                  Cancel
                </Button>
                <Button variant="primary" loading={createBusy} disabled={!newPath.trim()} onClick={() => void create()}>
                  Create & connect
                </Button>
              </div>
              {createError && <p className="ui-field-error settings-inline-error">{createError}</p>}
            </>
          )}
        </SettingsRow>
        <SettingsRow
          label="Find existing vaults"
          hint="Looks for Obsidian, NoPes and Markdown folders in Documents and your home folder."
          stacked={found !== null}
          control={
            found === null ? (
              <Button size="sm" variant="secondary" iconLeft={<FolderSearch size={13} />} loading={scanning} onClick={() => void scan()}>
                Search
              </Button>
            ) : undefined
          }
        >
          {found !== null &&
            (found.length === 0 ? (
              <EmptyState size="sm" icon={FolderSearch} title="No vaults found" description="Point to your folder above instead." />
            ) : (
              <ul className="ob-vault-list">
                {found.map((v) => (
                  <li key={v.path} className={v.path === vaultPath ? "ob-vault-row is-current" : "ob-vault-row"}>
                    <div className="ob-vault-text">
                      <span className="ob-vault-name">
                        {v.name} <Badge size="sm">{KIND_LABEL[v.kind]}</Badge>
                      </span>
                      <span className="ob-vault-path mono" title={v.path}>
                        {v.path}
                      </span>
                    </div>
                    <span className="ob-vault-count tabular">{v.note_count} notes</span>
                    {v.path === vaultPath ? (
                      <Badge variant="success">In use</Badge>
                    ) : (
                      <Button size="sm" variant="secondary" onClick={() => void save(v.path)}>
                        Use
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            ))}
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup
        title="Daily notes"
        description="Used for the layout of new starter vaults. Quick capture and the agent currently always write to daily/YYYY-MM-DD.md."
      >
        {prefs === null && !prefsError ? (
          <div className="ob-loading obs-pad">
            <Spinner size={14} /> Loading…
          </div>
        ) : (
          <>
            <SettingsRow
              label="Folder"
              hint="Relative to the vault; leave empty for the vault root."
              htmlFor="settings-daily-folder"
              control={
                <Input
                  id="settings-daily-folder"
                  size="sm"
                  value={prefsDraft.daily_folder}
                  onChange={(e) => setPrefsDraft((d) => ({ ...d, daily_folder: e.target.value }))}
                  spellCheck={false}
                  className="settings-select"
                />
              }
            />
            <SettingsRow
              label="File name pattern"
              hint={`YYYY, MM and DD are replaced — today: ${previewDailyName(prefsDraft.daily_filename_pattern.trim() || "YYYY-MM-DD")}`}
              htmlFor="settings-daily-pattern"
              control={
                <div className="obs-inline">
                  <Input
                    id="settings-daily-pattern"
                    size="sm"
                    value={prefsDraft.daily_filename_pattern}
                    onChange={(e) => setPrefsDraft((d) => ({ ...d, daily_filename_pattern: e.target.value }))}
                    spellCheck={false}
                    invalid={!!prefsError}
                    className="settings-select"
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && prefsDirty) void savePrefs();
                    }}
                  />
                  <Button size="sm" variant="primary" disabled={!prefsDirty} loading={savingPrefs} onClick={() => void savePrefs()}>
                    Save
                  </Button>
                </div>
              }
            >
              {prefsError && <p className="ui-field-error settings-inline-error">{prefsError}</p>}
            </SettingsRow>
          </>
        )}
      </SettingsGroup>
    </SettingsPage>
  );
}
