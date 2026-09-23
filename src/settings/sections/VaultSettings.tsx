import { useEffect, useState } from "react";
import { Check, FolderOpen } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { useAetherStore } from "../../lib/store";
import { getVaultPath, setVaultPath, getVaultNotes, getVaultStats, getVaultGraph, getHealth } from "../../lib/ipc";
import { Badge, Button, Input } from "../../ui";
import { SettingsGroup, SettingsPage, SettingsRow } from "../layout";

/** Vault location (moved from the former single-page SettingsPanel). */
export function VaultSettings() {
  const { vaultPath, setVaultPath: setStoreVaultPath, setVaultNotes, setVaultStats, setGraph, setHealth, vaultStats, health } =
    useAetherStore();
  const [pathInput, setPathInput] = useState(vaultPath ?? "");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void getVaultPath()
      .then((p) => {
        if (p) {
          setStoreVaultPath(p);
          setPathInput(p);
        }
      })
      .catch(() => undefined);
  }, [setStoreVaultPath]);

  const handleBrowse = async () => {
    try {
      const selected = await open({ directory: true, multiple: false });
      if (typeof selected === "string") setPathInput(selected);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleSave = async () => {
    if (!pathInput.trim()) return;
    setStatus("saving");
    setError(null);
    try {
      await setVaultPath(pathInput.trim());
      setStoreVaultPath(pathInput.trim());
      const [notes, stats, graph, h] = await Promise.all([getVaultNotes(), getVaultStats(), getVaultGraph(), getHealth()]);
      setVaultNotes(notes);
      setVaultStats(stats);
      setGraph(graph);
      setHealth(h);
      setStatus("saved");
      setTimeout(() => setStatus("idle"), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("error");
    }
  };

  return (
    <SettingsPage
      title="Vault"
      description="The folder of Markdown notes AETHER-OS reads and writes. Auto-detected if NoPes is installed."
    >
      <SettingsGroup>
        <SettingsRow
          label="Vault folder"
          hint="Point AETHER-OS to your NoPes vault. Notes stay plain Markdown files on disk."
          stacked
          htmlFor="settings-vault-path"
        >
          <div className="ui-field-row">
            <Input
              id="settings-vault-path"
              value={pathInput}
              onChange={(e) => setPathInput(e.target.value)}
              placeholder="/path/to/your/vault"
              invalid={status === "error"}
              spellCheck={false}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleSave();
              }}
            />
            <Button variant="secondary" iconLeft={<FolderOpen size={14} />} onClick={() => void handleBrowse()}>
              Browse
            </Button>
            <Button
              variant="primary"
              onClick={() => void handleSave()}
              loading={status === "saving"}
              disabled={!pathInput.trim()}
              iconLeft={status === "saved" ? <Check size={14} /> : undefined}
            >
              {status === "saved" ? "Saved" : "Save"}
            </Button>
          </div>
          {error && <p className="ui-field-error settings-inline-error">{error}</p>}
        </SettingsRow>
        <SettingsRow
          label="Status"
          hint="Counts refresh whenever notes change."
          control={
            <div className="settings-badges">
              <Badge variant={health?.vault_connected || vaultPath ? "success" : "neutral"} dot>
                {health?.vault_connected || vaultPath ? "Connected" : "Not connected"}
              </Badge>
              {vaultStats && <Badge>{vaultStats.note_count} notes</Badge>}
            </div>
          }
        />
      </SettingsGroup>
    </SettingsPage>
  );
}
