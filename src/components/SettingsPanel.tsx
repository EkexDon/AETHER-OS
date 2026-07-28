import React, { useState, useEffect } from "react";
import { Settings, FolderOpen, Check, AlertCircle } from "lucide-react";
import { useAetherStore } from "../lib/store";
import { getVaultPath, setVaultPath, getVaultNotes, getVaultStats, getVaultGraph, getHealth } from "../lib/ipc";
import { open } from "@tauri-apps/plugin-dialog";

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const {
    vaultPath,
    setVaultPath: setStoreVaultPath,
    setVaultNotes,
    setVaultStats,
    setGraph,
    setHealth,
  } = useAetherStore();
  const [pathInput, setPathInput] = useState(vaultPath ?? "");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void getVaultPath().then((p) => {
      if (p) {
        setStoreVaultPath(p);
        setPathInput(p);
      }
    });
  }, [setStoreVaultPath]);

  const handleBrowse = async () => {
    try {
      const selected = await open({ directory: true, multiple: false });
      if (typeof selected === "string") {
        setPathInput(selected);
      }
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
      const [notes, stats, graph, health] = await Promise.all([
        getVaultNotes(),
        getVaultStats(),
        getVaultGraph(),
        getHealth(),
      ]);
      setVaultNotes(notes);
      setVaultStats(stats);
      setGraph(graph);
      setHealth(health);
      setStatus("saved");
      setTimeout(() => setStatus("idle"), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("error");
    }
  };

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <Settings size={20} />
          <span>Settings</span>
        </div>

        <div className="settings-section">
          <label className="settings-label">NoPes Vault Path</label>
          <p className="settings-hint">
            Point AETHER-OS to your NoPes vault folder. Auto-detected if NoPes is installed.
          </p>
          <div className="settings-path-row">
            <input
              type="text"
              value={pathInput}
              onChange={(e) => setPathInput(e.target.value)}
              placeholder="/path/to/your/vault"
              className="settings-input"
            />
            <button className="btn btn-secondary" onClick={handleBrowse}>
              <FolderOpen size={16} />
              Browse
            </button>
            <button className="btn btn-primary" onClick={handleSave} disabled={status === "saving" || !pathInput.trim()}>
              {status === "saving" ? "Saving..." : status === "saved" ? <><Check size={16} /> Saved</> : "Save"}
            </button>
          </div>
          {error && (
            <div className="settings-error">
              <AlertCircle size={14} />
              {error}
            </div>
          )}
        </div>

        <div className="settings-section">
          <label className="settings-label">AI Model</label>
          <p className="settings-hint">
            AETHER uses Ollama locally. Default model: llama3.2. Install with: ollama pull llama3.2
          </p>
        </div>
      </div>
    </div>
  );
}
