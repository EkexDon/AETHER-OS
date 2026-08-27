import React, { useState, useEffect } from "react";
import { Settings, FolderOpen, Check, AlertCircle, Cloud, Loader2 } from "lucide-react";
import { useAetherStore } from "../lib/store";
import { getVaultPath, setVaultPath, getVaultNotes, getVaultStats, getVaultGraph, getHealth, setOpenRouterKey, listCloudModels } from "../lib/ipc";
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
    health,
  } = useAetherStore();
  const [pathInput, setPathInput] = useState(vaultPath ?? "");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [customEditor, setCustomEditor] = useState("");
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [keyStatus, setKeyStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [keyMessage, setKeyMessage] = useState<string | null>(null);
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

  const handleSaveKey = async () => {
    if (!apiKeyInput.trim()) return;
    setKeyStatus("saving");
    setKeyMessage(null);
    try {
      await setOpenRouterKey(apiKeyInput.trim());
      setApiKeyInput("");
      const h = await getHealth();
      setHealth(h);
      setKeyStatus("saved");
      setKeyMessage("Key saved.");
      setTimeout(() => setKeyStatus("idle"), 2000);
    } catch (e) {
      setKeyMessage(e instanceof Error ? e.message : String(e));
      setKeyStatus("error");
    }
  };

  const handleTestKey = async () => {
    setKeyStatus("saving");
    setKeyMessage(null);
    try {
      const models = await listCloudModels();
      setKeyStatus("saved");
      setKeyMessage(`Connected — ${models.length} models available.`);
      setTimeout(() => setKeyStatus("idle"), 3000);
    } catch (e) {
      setKeyMessage(e instanceof Error ? e.message : String(e));
      setKeyStatus("error");
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
          <label className="settings-label">AI Providers</label>
          <p className="settings-hint">
            AETHER chats through local Ollama by default, or cloud models via OpenRouter
            (claude, gpt, gemini and more). Your key is stored in the app's private data
            directory — never in the browser or your vault.
          </p>
          <div className="settings-provider-status">
            <span className={`engine-badge ${health?.ollama_online ? "engine-online" : "engine-offline"}`}>
              Ollama {health?.ollama_online ? "connected" : "offline"}
            </span>
            <span className={`engine-badge ${health?.openrouter_configured ? "engine-online" : "engine-offline"}`}>
              OpenRouter {health?.openrouter_configured ? "connected" : "no key"}
            </span>
          </div>
          <label className="settings-label settings-label-sub">OpenRouter API Key</label>
          <div className="settings-path-row">
            <input
              type="password"
              value={apiKeyInput}
              onChange={(e) => setApiKeyInput(e.target.value)}
              placeholder={health?.openrouter_configured ? "•••••••• (saved)" : "sk-or-v1-..."}
              className="settings-input"
              autoComplete="off"
            />
            <button className="btn btn-secondary" onClick={() => void handleTestKey()} disabled={keyStatus === "saving"}>
              {keyStatus === "saving" ? <Loader2 size={16} className="spin" /> : <Cloud size={16} />}
              Test
            </button>
            <button className="btn btn-primary" onClick={() => void handleSaveKey()} disabled={keyStatus === "saving" || !apiKeyInput.trim()}>
              {keyStatus === "saved" ? <><Check size={16} /> Saved</> : "Save Key"}
            </button>
          </div>
          {keyMessage && (
            <div className={keyStatus === "error" ? "settings-error" : "settings-hint"}>
              {keyStatus === "error" && <AlertCircle size={14} />}
              {keyMessage}
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
          <label className="settings-label">Local Model</label>
          <p className="settings-hint">
            Ollama default model: gemma2:2b. Install with: ollama pull gemma2:2b — or pick any
            installed model from the chat header.
          </p>
        </div>
      </div>
    </div>
  );
}
