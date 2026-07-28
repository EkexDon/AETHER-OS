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
    preferredEditor,
    setPreferredEditor,
  } = useAetherStore();
  const [pathInput, setPathInput] = useState(vaultPath ?? "");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [customEditor, setCustomEditor] = useState("");
  const isKnownEditor = ["devin", "windsurf", "cursor", "code"].includes(preferredEditor);

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
          <label className="settings-label">Default Editor</label>
          <p className="settings-hint">
            App used to open your projects from the Project Dashboard.
          </p>
          <select
            className="settings-input"
            value={isKnownEditor ? preferredEditor : "custom"}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "custom") {
                setCustomEditor(preferredEditor);
              } else {
                setPreferredEditor(v);
              }
            }}
          >
            <option value="devin">Devin</option>
            <option value="windsurf">Windsurf</option>
            <option value="cursor">Cursor</option>
            <option value="code">VS Code</option>
            <option value="custom">Custom...</option>
          </select>
          {(!isKnownEditor || customEditor) && (
            <div className="settings-path-row" style={{ marginTop: 8 }}>
              <input
                type="text"
                className="settings-input"
                placeholder="Exact macOS app name, e.g. Zed"
                value={customEditor || (!isKnownEditor ? preferredEditor : "")}
                onChange={(e) => setCustomEditor(e.target.value)}
              />
              <button
                className="btn btn-primary"
                onClick={() => {
                  if (customEditor.trim()) {
                    setPreferredEditor(customEditor.trim());
                    setCustomEditor("");
                  }
                }}
              >
                Use
              </button>
            </div>
          )}
        </div>

        <div className="settings-section">
          <label className="settings-label">AI Model</label>
          <p className="settings-hint">
            AETHER uses Ollama locally. Default model: gemma2:2b. Install with: ollama pull gemma2:2b
          </p>
        </div>
      </div>
    </div>
  );
}
