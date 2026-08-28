import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { Send, Bot, Loader, FileText, Save, User, X, Check, Layers, History, Plus, Zap, Cloud, HardDrive } from "lucide-react";
import { useAetherStore, type AiProvider } from "../lib/store";
import {
  agentQueryWithNotes, onStreamChunk, createAetherNote, getAetherNotes,
  saveConversation, getRecentConversations, deleteConversation,
  executeAgentAction, getVaultNotes, listLocalModels, listCloudModels,
  agentOpenUrl, agentClipUrl, agentAddMemoryFact, agentSaveAetherNote,
  type AgentActionResult,
} from "../lib/ipc";
import { parseAgentActions, describeAction, actionLabel } from "../lib/agentActions";
import { supportsAgentActions } from "../lib/agentModelSupport";
import { buildClipNote, clipNoteName } from "../lib/clipper";
import { createNote } from "../lib/ipc";
import { filterModels, parseSlashInput } from "../lib/slash";
import type { AgentAction } from "../types";

type ChatMessage = { role: "user" | "assistant"; content: string };

/** Memoized so streaming updates never re-render the whole history. */
const ChatMessageRow = React.memo(function ChatMessageRow({
  role,
  content,
}: ChatMessage) {
  return (
    <div className={`chat-msg chat-msg-${role}`}>
      <div className="chat-msg-icon">
        {role === "user" ? <User size={14} /> : <Bot size={14} />}
      </div>
      <div className="chat-msg-content">{content}</div>
    </div>
  );
});

export function AgentChat({ width = 340 }: { width?: number }) {
  const {
    agentOutput,
    appendAgentOutput,
    clearAgentOutput,
    agentContext,
    setAgentContext,
    setAetherNotes,
    busy,
    setBusy,
    selectedNotePath,
    vaultNotes,
    contextNotes,
    allNotesInContext,
    toggleContextNote,
    resetContextToAll,
    conversations,
    setConversations,
    provider,
    setProvider,
    modelByProvider,
    setModelForProvider,
    health,
    setChatOpen,
  } = useAetherStore();

  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const pendingUserMsg = useRef<string | null>(null);
  const [showContextPicker, setShowContextPicker] = useState(false);
  const [contextSearch, setContextSearch] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const [pendingActions, setPendingActions] = useState<AgentAction[]>([]);
  const [actionResults, setActionResults] = useState<Record<number, string>>({});
  const [actionExecuting, setActionExecuting] = useState<number | null>(null);
  const [localModels, setLocalModels] = useState<string[]>([]);
  const [cloudModels, setCloudModels] = useState<string[]>([]);
  const [slashIndex, setSlashIndex] = useState(0);

  const currentModel = modelByProvider[provider];

  const providerModels = useMemo(
    () =>
      provider === "ollama"
        ? (localModels.length > 0 ? localModels : [currentModel])
        : (cloudModels.length > 0 ? cloudModels : [currentModel]),
    [provider, localModels, cloudModels, currentModel]
  );

  const slash = parseSlashInput(input);
  const slashMatches = useMemo(
    () => (slash ? filterModels(providerModels, slash.query) : []),
    [slash, providerModels]
  );

  useEffect(() => {
    setSlashIndex(0);
  }, [slash?.query, provider]);

  useEffect(() => {
    void getRecentConversations(20).then(setConversations).catch(() => {});
  }, [setConversations]);

  useEffect(() => {
    if (provider !== "ollama" || localModels.length > 0) return;
    void listLocalModels().then(setLocalModels).catch(() => {});
  }, [provider, localModels.length]);

  useEffect(() => {
    if (provider !== "openrouter" || cloudModels.length > 0 || !health?.openrouter_configured) return;
    void listCloudModels().then(setCloudModels).catch(() => {});
  }, [provider, cloudModels.length, health?.openrouter_configured]);

  const handleModelChange = useCallback(
    (model: string) => setModelForProvider(provider, model),
    [provider, setModelForProvider]
  );

  const applySlashModel = useCallback(
    (model: string) => {
      handleModelChange(model);
      setInput("");
    },
    [handleModelChange]
  );

  const activeContextPaths = useMemo(() => {
    if (allNotesInContext) return vaultNotes.map((n) => n.path);
    return vaultNotes.filter((n) => contextNotes.has(n.path)).map((n) => n.path);
  }, [allNotesInContext, contextNotes, vaultNotes]);

  const filteredContextNotes = useMemo(() => {
    if (!contextSearch.trim()) return vaultNotes;
    const q = contextSearch.toLowerCase();
    return vaultNotes.filter((n) => n.name.toLowerCase().includes(q) || n.path.toLowerCase().includes(q));
  }, [vaultNotes, contextSearch]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void onStreamChunk(appendAgentOutput)
      .then((fn) => {
        if (cancelled) {
          fn();
        } else {
          unlisten = fn;
        }
      })
      .catch((reason) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [appendAgentOutput]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [agentOutput, messages]);

  useEffect(() => {
    if (!busy && agentOutput && pendingUserMsg.current) {
      const userMsg = pendingUserMsg.current;
      const aiMsg = agentOutput;
      setMessages((prev) => [...prev, { role: "user", content: userMsg }, { role: "assistant", content: aiMsg }]);
      // Parse agent actions from the AI output and auto-execute the
      // safe ones. v1 has no destructive tools, so every action is
      // safe to run immediately. Future versions that add terminal /
      // git / file-delete will gate those behind the existing
      // approval panel (which is still wired up below).
      const actions = parseAgentActions(aiMsg);
      if (actions.length > 0) {
        setPendingActions((prev) => [...prev, ...actions]);
        void runActionBatch(actions);
      }
      pendingUserMsg.current = null;
      clearAgentOutput();
      void saveConversation(
        [{ role: "user", content: userMsg }, { role: "assistant", content: aiMsg }],
        agentContext
      ).then((conv) => {
        setConversations([conv, ...useAetherStore.getState().conversations].slice(0, 20));
      }).catch(() => {});
    }
  }, [busy, agentOutput, clearAgentOutput, agentContext, setConversations]);

  const loadConversation = (convId: string) => {
    const conv = conversations.find((c) => c.id === convId);
    if (!conv) return;
    setMessages(
      conv.messages.map((m) => ({ role: m.role as "user" | "assistant", content: m.content }))
    );
    setShowHistory(false);
  };

  const handleDeleteConversation = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await deleteConversation(id);
      setConversations(conversations.filter((c) => c.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const startNewChat = () => {
    setMessages([]);
    clearAgentOutput();
    setShowHistory(false);
  };

  const handleSubmit = async () => {
    if (!input.trim() || busy) return;
    setError(null);
    const prompt = input.trim();
    pendingUserMsg.current = prompt;
    clearAgentOutput();
    setBusy(true);
    setInput("");

    try {
      const notePaths = activeContextPaths.length > 0 ? activeContextPaths : vaultNotes.map((n) => n.path);
      setAgentContext(notePaths);
      await agentQueryWithNotes(prompt, notePaths, currentModel, provider);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const lastAssistantMsg = useMemo(
    () => [...messages].reverse().find((m) => m.role === "assistant"),
    [messages]
  );
  const savableContent = agentOutput.trim() || lastAssistantMsg?.content.trim() || "";

  const handleSave = async () => {
    if (!savableContent) return;
    try {
      const title = `AI Response — ${new Date().toLocaleString()}`;
      const lastUserMsg = [...messages].reverse().find((m) => m.role === "user")?.content || "";
      await createAetherNote(title, savableContent, lastUserMsg, agentContext);
      const notes = await getAetherNotes();
      setAetherNotes(notes);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleExecuteAction = async (index: number) => {
    const action = pendingActions[index];
    if (!action) return;
    setActionExecuting(index);
    try {
      const result = await executeOneAction(action);
      setActionResults((prev) => ({ ...prev, [index]: result }));
      await maybeRefreshVaultAfter(action);
    } catch (e) {
      setActionResults((prev) => ({ ...prev, [index]: `Error: ${e}` }));
    } finally {
      setActionExecuting(null);
    }
  };

  /**
   * Execute a list of agent actions sequentially. Used as the v1
   * default — every action is safe-write or read+save, so the user
   * sees the result in the chat without a per-action modal.
   */
  const runActionBatch = async (actions: AgentAction[]) => {
    // Track which pending action indices these are. They were appended
    // to `pendingActions` right before this call, so the offsets are
    // `length - actions.length .. length - 1`.
    const baseIndex = pendingActions.length - actions.length;
    for (let i = 0; i < actions.length; i++) {
      const idx = baseIndex + i;
      setActionExecuting(idx);
      try {
        const result = await executeOneAction(actions[i]);
        setActionResults((prev) => ({ ...prev, [idx]: result }));
        await maybeRefreshVaultAfter(actions[i]);
      } catch (e) {
        setActionResults((prev) => ({ ...prev, [idx]: `Error: ${e}` }));
      } finally {
        setActionExecuting(null);
      }
    }
  };

  /** Route a single action to the right IPC command and return a
   *  human-readable result string for the chat. */
  const executeOneAction = async (action: AgentAction): Promise<string> => {
    switch (action.action) {
      case "create_note":
      case "append_note":
      case "append_daily": {
        const result = await executeAgentAction(action);
        return result;
      }
      case "add_memory_fact": {
        const result = await agentAddMemoryFact(action.fact, action.category);
        return result.kind === "fact_saved" ? `Remembered fact: "${action.fact}"` : "Fact saved";
      }
      case "save_aether_note": {
        const result = await agentSaveAetherNote(action.title, action.content);
        return result.kind === "aether_note_saved" ? `Saved to AETHER Notes: "${action.title}"` : "Saved to AETHER Notes";
      }
      case "open_url": {
        await agentOpenUrl(action.url);
        return `Opened ${action.url}`;
      }
      case "clip_url": {
        // Backend returns the extracted HTML; we convert to MD in the
        // frontend (turndown is a JS dep) and create the note here.
        const result: AgentActionResult = await agentClipUrl(action.url);
        if (result.kind !== "clipped_page") return "Clip failed";
        const noteName = clipNoteName(result.path.title, new Date());
        const noteBody = buildClipNote(result.path, new Date());
        const relPath = `clips/${noteName}`;
        const created = await createNote(relPath, noteBody);
        return `Clipped to ${created}`;
      }
    }
  };

  /** After actions that change vault state, refresh the sidebar. */
  const maybeRefreshVaultAfter = async (action: AgentAction) => {
    if (
      action.action === "create_note" ||
      action.action === "append_note" ||
      action.action === "append_daily" ||
      action.action === "clip_url"
    ) {
      const notes = await getVaultNotes();
      useAetherStore.getState().setVaultNotes(notes);
    }
    if (action.action === "save_aether_note") {
      const notes = await getAetherNotes();
      setAetherNotes(notes);
    }
  };

  const handleDismissAction = (index: number) => {
    setPendingActions((prev) => prev.filter((_, i) => i !== index));
  };

  return (
    <div className="agent-chat" style={{ width, minWidth: width }}>
      <div className="agent-header">
        <Bot size={18} />
        <span className="agent-title">AETHER Agent</span>
        <span className={`agent-status ${busy ? "agent-busy" : ""}`}>
          {busy ? "Thinking..." : "Ready"}
        </span>
        <button
          className="btn btn-icon agent-header-btn"
          onClick={() => setShowHistory((v) => !v)}
          title="Conversation history"
        >
          <History size={14} />
        </button>
        <button
          className="btn btn-icon agent-header-btn"
          onClick={startNewChat}
          title="New chat"
        >
          <Plus size={14} />
        </button>
        <button
          className="btn btn-icon agent-header-btn"
          onClick={() => setChatOpen(false)}
          title="Close panel"
        >
          <X size={14} />
        </button>
      </div>

      <div className="agent-engine-bar">
        <select
          className="agent-provider-select"
          value={provider}
          onChange={(e) => setProvider(e.target.value as AiProvider)}
          title="AI provider"
        >
          <option value="ollama">Ollama · Local</option>
          <option value="openrouter">OpenRouter · Cloud</option>
        </select>
        <select
          className="agent-model-select"
          value={currentModel}
          onChange={(e) => handleModelChange(e.target.value)}
          title="Model"
        >
          {(provider === "ollama"
            ? (localModels.length > 0 ? localModels : [currentModel])
            : (cloudModels.length > 0 ? cloudModels : [currentModel])
          ).map((model) => (
            <option key={model} value={model}>{model}</option>
          ))}
        </select>
        {provider === "ollama" ? (
          <span
            className={`engine-badge ${health?.ollama_online ? "engine-online" : "engine-offline"}`}
            title={health?.ollama_online ? "Ollama is running locally" : "Ollama is offline"}
          >
            {health?.ollama_online ? <HardDrive size={11} /> : <HardDrive size={11} />}
            {health?.ollama_online ? "connected" : "offline"}
          </span>
        ) : (
          <span
            className={`engine-badge ${health?.openrouter_configured ? "engine-online" : "engine-offline"}`}
            title={
              health?.openrouter_configured
                ? "OpenRouter API key configured"
                : "Add your OpenRouter key in Settings"
            }
          >
            <Cloud size={11} />
            {health?.openrouter_configured ? "connected" : "no key"}
          </span>
        )}
        {!supportsAgentActions(currentModel, provider) && (
          <span
            className="engine-badge engine-warn"
            title="This model may not emit tool calls reliably. Actions will still be parsed from the reply if present."
          >
            <Zap size={11} />
            tools: unreliable
          </span>
        )}
      </div>

      {showHistory && (
        <div className="agent-history">
          {conversations.length === 0 ? (
            <div className="agent-history-empty">No past conversations</div>
          ) : (
            conversations.map((c) => (
              <div key={c.id} className="agent-history-item" onClick={() => loadConversation(c.id)}>
                <span className="agent-history-summary">{c.summary || "Conversation"}</span>
                <span className="agent-history-time">
                  {new Date(c.timestamp * 1000).toLocaleDateString()}
                </span>
                <button
                  className="agent-history-delete"
                  onClick={(e) => void handleDeleteConversation(c.id, e)}
                >
                  <X size={12} />
                </button>
              </div>
            ))
          )}
        </div>
      )}

      <div className="agent-context-bar">
        <button
          className="btn btn-icon agent-context-toggle"
          onClick={() => setShowContextPicker((v) => !v)}
          title="Select context notes"
        >
          <Layers size={14} />
        </button>
        <span className="agent-context-label">
          {allNotesInContext
            ? `All notes (${vaultNotes.length})`
            : `${activeContextPaths.length} of ${vaultNotes.length} notes`}
        </span>
        {!allNotesInContext && (
          <button
            className="btn btn-icon agent-context-reset"
            onClick={resetContextToAll}
            title="Reset to all notes"
          >
            <Check size={12} />
          </button>
        )}
      </div>

      {showContextPicker && (
        <div className="context-picker">
          <div className="context-picker-header">
            <span className="context-picker-title">Context Notes</span>
            <button className="btn btn-icon" onClick={() => setShowContextPicker(false)}>
              <X size={14} />
            </button>
          </div>
          <div className="context-picker-search">
            <input
              type="text"
              placeholder="Filter notes..."
              value={contextSearch}
              onChange={(e) => setContextSearch(e.target.value)}
              className="sidebar-search-input"
              style={{ paddingLeft: "10px" }}
            />
          </div>
          <div className="context-picker-list">
            <div
              className={`context-picker-row ${allNotesInContext ? "context-picker-selected" : ""}`}
              onClick={resetContextToAll}
            >
              <Check size={14} className="context-check" />
              <span className="context-picker-all-label">All notes ({vaultNotes.length})</span>
            </div>
            {filteredContextNotes.map((note) => {
              const isSelected = allNotesInContext || contextNotes.has(note.path);
              return (
                <div
                  key={note.path}
                  className={`context-picker-row ${isSelected ? "context-picker-selected" : ""}`}
                  onClick={() => toggleContextNote(note.path)}
                >
                  <span className="context-check-wrapper">
                    {isSelected && <Check size={14} className="context-check" />}
                  </span>
                  <FileText size={12} className="context-note-icon" />
                  <span className="context-note-name">{note.name.replace(/\.md$/i, "")}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="agent-output" ref={scrollRef}>
        {messages.length === 0 && !agentOutput && !busy && (
          <div className="agent-placeholder">
            <Bot size={32} />
            <p>Ask AETHER anything about your vault</p>
          </div>
        )}
        {messages.map((msg, i) => (
          <ChatMessageRow key={i} role={msg.role} content={msg.content} />
        ))}
        {busy && (
          <div className="chat-msg chat-msg-assistant">
            <div className="chat-msg-icon"><Bot size={14} /></div>
            <div className="chat-msg-content">
              {agentOutput ? (
                <span className="agent-stream">
                  {agentOutput}
                  <span className="stream-cursor" />
                </span>
              ) : (
                <span className="chat-typing" aria-label="Assistant is typing">
                  <span /><span /><span />
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      {pendingActions.length > 0 && (
        <div className="agent-actions-panel">
          <div className="agent-actions-header">
            <Zap size={14} />
            <span>Tools used ({pendingActions.length})</span>
          </div>
          {pendingActions.map((action, idx) => (
            <div key={idx} className="agent-action-card">
              <div className="agent-action-desc">
                {actionResults[idx]
                  ? actionLabel(action)
                  : (
                    <>
                      {actionExecuting === idx && <Loader size={12} className="spin" />}
                      <span>{describeAction(action)}</span>
                    </>
                  )}
              </div>
              {actionResults[idx] && (
                <div className="agent-action-result">{actionResults[idx]}</div>
              )}
            </div>
          ))}
        </div>
      )}

      {error && <div className="agent-error">{error}</div>}

      {slash && (
        <div className="slash-menu" role="listbox" aria-label="Model picker">
          <div className="slash-menu-header">
            Models · {provider === "ollama" ? "Ollama" : "OpenRouter"}
            {health?.openrouter_configured === false && provider === "openrouter" && " (no key)"}
          </div>
          <div className="slash-menu-list">
            {slashMatches.length === 0 && (
              <div className="slash-menu-empty">No matching models</div>
            )}
            {slashMatches.map((model, i) => (
              <div
                key={model}
                role="option"
                aria-selected={i === slashIndex}
                className={`slash-menu-item${i === slashIndex ? " slash-menu-active" : ""}${
                  model === currentModel ? " slash-menu-current" : ""
                }`}
                onMouseEnter={() => setSlashIndex(i)}
                onClick={() => applySlashModel(model)}
              >
                {model}
                {model === currentModel && <span className="slash-menu-check">current</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="agent-input-row">
        <textarea
          className="agent-input"
          placeholder="Ask about your notes... (/model to switch)"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (slash && slashMatches.length > 0) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSlashIndex((i) => (i + 1) % slashMatches.length);
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setSlashIndex((i) => (i - 1 + slashMatches.length) % slashMatches.length);
                return;
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                applySlashModel(slashMatches[slashIndex] ?? currentModel);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setInput("");
                return;
              }
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSubmit();
            }
          }}
          rows={2}
        />
        <div className="agent-actions">
          <button
            className="btn btn-icon"
            onClick={handleSave}
            disabled={!savableContent || busy}
            title="Save as AETHER Note"
          >
            <Save size={16} />
          </button>
          <button
            className="btn btn-primary btn-send"
            onClick={handleSubmit}
            disabled={!input.trim() || busy}
          >
            {busy ? <Loader size={16} className="spin" /> : <Send size={16} />}
          </button>
        </div>
      </div>
    </div>
  );
}
