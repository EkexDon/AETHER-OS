import { useEffect, useState } from "react";
import { CircleCheck, FolderOpen, FolderPlus, FolderSearch } from "lucide-react";
import type { VaultInfo, VaultKind } from "../../../types";
import { createStarterVault, detectVaults, suggestVaultPath } from "../../../lib/ipc";
import { useAetherStore } from "../../../lib/store";
import { canPickFolder, connectVault, folderName, pickFolder } from "../../../lib/onboarding/vaultActions";
import { Badge, Button, EmptyState, Input, Spinner, cx, useToast } from "../../../ui";

/** Badge label per vault kind. */
export const VAULT_KIND_LABEL: Record<VaultKind, string> = {
  nopes: "NoPes",
  obsidian: "Obsidian",
  plain: "Markdown",
};

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Step 2 — connect an existing vault, pick a folder or create a starter vault. */
export function VaultStep() {
  const toast = useToast();
  const vaultPath = useAetherStore((s) => s.vaultPath);
  const noteCount = useAetherStore((s) => s.vaultStats?.note_count ?? s.vaultNotes.length);
  const [detected, setDetected] = useState<VaultInfo[] | null>(null);
  const [detectError, setDetectError] = useState<string | null>(null);
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [mode, setMode] = useState<"idle" | "create" | "manual">("idle");
  const [newPath, setNewPath] = useState("");
  const [manualPath, setManualPath] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    detectVaults()
      .then((list) => alive && setDetected(list))
      .catch((e) => {
        if (!alive) return;
        setDetected([]);
        setDetectError(errorText(e));
      });
    return () => {
      alive = false;
    };
  }, []);

  const use = async (path: string, label?: string) => {
    setBusyPath(path);
    setFormError(null);
    try {
      await connectVault(path);
      toast.success("Vault connected", { description: label ?? path });
      setMode("idle");
    } catch (e) {
      setFormError(errorText(e));
    } finally {
      setBusyPath(null);
    }
  };

  const openCreate = async () => {
    setMode("create");
    setFormError(null);
    if (!newPath) {
      try {
        setNewPath(await suggestVaultPath());
      } catch (e) {
        setFormError(errorText(e));
      }
    }
  };

  const create = async () => {
    setBusyPath("__create__");
    setFormError(null);
    try {
      const info = await createStarterVault(newPath);
      await connectVault(info.path);
      toast.success("Starter vault created", { description: `${info.note_count} notes in ${info.name}` });
      setMode("idle");
    } catch (e) {
      setFormError(errorText(e));
    } finally {
      setBusyPath(null);
    }
  };

  const browse = async () => {
    if (!canPickFolder()) {
      setMode("manual");
      return;
    }
    try {
      const picked = await pickFolder();
      if (picked) await use(picked, folderName(picked));
    } catch (e) {
      setFormError(errorText(e));
    }
  };

  const busy = busyPath !== null;

  return (
    <div className="ob-step-stack">
      {vaultPath && (
        <div className="ob-connected">
          <CircleCheck size={16} className="ob-connected-icon" />
          <div className="ob-connected-text">
            <span className="ob-connected-title">
              Connected to <strong>{folderName(vaultPath)}</strong>
            </span>
            <span className="ob-connected-path mono" title={vaultPath}>
              {vaultPath}
            </span>
          </div>
          <Badge>{noteCount} notes</Badge>
        </div>
      )}

      <section className="ob-section" aria-labelledby="ob-found-title">
        <h3 id="ob-found-title" className="ui-section-label">
          Found on this computer
        </h3>
        {detected === null ? (
          <div className="ob-loading">
            <Spinner size={14} /> Looking for vaults in Documents and your home folder…
          </div>
        ) : detected.length === 0 ? (
          <EmptyState
            size="sm"
            icon={FolderSearch}
            title="No existing vaults found"
            description={detectError ?? "Choose a folder yourself or start with a fresh starter vault."}
          />
        ) : (
          <ul className="ob-vault-list">
            {detected.map((v) => {
              const current = v.path === vaultPath;
              return (
                <li key={v.path} className={cx("ob-vault-row", current && "is-current")}>
                  <div className="ob-vault-text">
                    <span className="ob-vault-name">
                      {v.name}
                      <Badge size="sm" variant={v.kind === "plain" ? "neutral" : "info"}>
                        {VAULT_KIND_LABEL[v.kind]}
                      </Badge>
                    </span>
                    <span className="ob-vault-path mono" title={v.path}>
                      {v.path}
                    </span>
                  </div>
                  <span className="ob-vault-count tabular">{v.note_count} notes</span>
                  {current ? (
                    <Badge variant="success">In use</Badge>
                  ) : (
                    <Button size="sm" variant="secondary" loading={busyPath === v.path} disabled={busy} onClick={() => void use(v.path, v.name)}>
                      Use
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <div className="ob-actions-row">
        <Button variant="secondary" iconLeft={<FolderOpen size={14} />} onClick={() => void browse()} disabled={busy}>
          Choose a folder…
        </Button>
        <Button
          variant={vaultPath ? "ghost" : "secondary"}
          iconLeft={<FolderPlus size={14} />}
          onClick={() => void openCreate()}
          disabled={busy}
          aria-expanded={mode === "create"}
        >
          Create a new vault
        </Button>
      </div>

      {mode === "create" && (
        <div className="ob-inline-form">
          <label className="ui-field-label" htmlFor="ob-new-vault">
            New vault folder
          </label>
          <div className="ui-field-row">
            <Input
              id="ob-new-vault"
              value={newPath}
              onChange={(e) => setNewPath(e.target.value)}
              spellCheck={false}
              invalid={!!formError}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newPath.trim()) void create();
              }}
              autoFocus
            />
            <Button variant="primary" loading={busyPath === "__create__"} disabled={!newPath.trim() || busy} onClick={() => void create()}>
              Create
            </Button>
          </div>
          <span className="ui-field-hint">
            Creates Welcome, a README on links, tags and tasks, today's daily note, and Projects/ and Resources/ folders.
          </span>
        </div>
      )}

      {mode === "manual" && (
        <div className="ob-inline-form">
          <label className="ui-field-label" htmlFor="ob-manual-vault">
            Folder path
          </label>
          <div className="ui-field-row">
            <Input
              id="ob-manual-vault"
              value={manualPath}
              onChange={(e) => setManualPath(e.target.value)}
              placeholder="/Users/you/Documents/Notes"
              spellCheck={false}
              invalid={!!formError}
              onKeyDown={(e) => {
                if (e.key === "Enter" && manualPath.trim()) void use(manualPath.trim());
              }}
              autoFocus
            />
            <Button variant="primary" loading={busyPath === manualPath.trim()} disabled={!manualPath.trim() || busy} onClick={() => void use(manualPath.trim())}>
              Use folder
            </Button>
          </div>
          <span className="ui-field-hint">The folder picker needs the desktop app — type the path instead.</span>
        </div>
      )}

      {formError && (
        <p className="ui-field-error" role="alert">
          {formError}
        </p>
      )}
    </div>
  );
}
